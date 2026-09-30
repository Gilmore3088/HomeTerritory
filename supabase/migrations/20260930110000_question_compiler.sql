-- Phase 3, P3b-1: the question compiler.
--
-- Templates (facts.question_templates) x facts -> public.questions, entirely
-- in-database under service_role. The compiler contract (also documented on
-- the templates table): a template's answer_sql is wrapped and must yield
--   family_entity text   -- entity id anchoring the near-duplicate family
--   territory_id  text   -- the state the question fights for
--   params        jsonb  -- {slot: value} for text rendering
--   answer        text
--   aliases       text[] -- accepted variants (answer is added automatically)
--   prominence    numeric-- 0..1, drives tier adjustment
--   fact_refs     jsonb  -- [{table, id}] provenance chain
--   verified      bool   -- Gate B: computed FROM THE FACTS' confidence
-- distractor_sql (multiple choice only) takes $1 = params jsonb and yields
-- candidate texts, most plausible first.
--
-- Gate A (compile-time lint, every instance):
--   * territory must be a real state; text fully rendered (no '{' left)
--   * the answer must not appear in the question text
--   * a distractor may not normalize equal to -- or sit within fuzzy-match
--     distance of -- the answer or any alias: anything answer_matches()
--     would grade correct is disqualified as a distractor
--   * enough surviving distractors to fill option_count, else skip
-- Gate B: verified = false rows are skipped and counted, never compiled.
--
-- Idempotency: unique (template_id, family_key); recompiles refresh text,
-- options, aliases, tier and prominence but never resurrect a question the
-- telemetry or a reviewer retired (active stays as it is on conflict).

alter table public.questions
  add column template_id uuid references facts.question_templates(id),
  add column fact_refs jsonb,
  add column family_key text,
  add column prominence numeric;

-- Hand-written rows form single-member families: they are their own clones.
update public.questions set family_key = id::text where family_key is null;

create unique index questions_template_family_ux
  on public.questions(template_id, family_key)
  where template_id is not null;
create index questions_family_active_idx
  on public.questions(territory_id, family_key)
  where active;

-- ------------------------------------------------- derived state links

create or replace function public.refresh_derived()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_links integer;
begin
  -- The spine is a pure derivation of the warehouse: rebuild it wholesale.
  delete from facts.state_links;
  insert into facts.state_links(entity_type, entity_id, state, link_kind, strength)
  select distinct * from (
    select 'athlete', a.id, a.birth_state, 'born_in', 'primary'
    from facts.athletes a
    join public.territories t on t.id = a.birth_state
    union all
    select 'team', tm.id, tm.state, 'team_plays_in', 'primary'
    from facts.teams tm
    join public.territories t on t.id = tm.state
    union all
    select 'venue', v.id, v.state, 'venue_in', 'primary'
    from facts.venues v
    join public.territories t on t.id = v.state
    union all
    select 'college', c.id, c.state, 'college_in', 'primary'
    from facts.colleges c
    join public.territories t on t.id = c.state
    union all
    select 'event', e.id, e.state, 'event_hosted_in', 'primary'
    from facts.events e
    join public.territories t on t.id = e.state
    union all
    select 'championship', ch.id, tm.state, 'champion_from', 'secondary'
    from facts.championships ch
    join facts.teams tm on tm.id = ch.winner_team_id
    join public.territories t on t.id = tm.state
  ) links(entity_type, entity_id, state, link_kind, strength);
  get diagnostics v_links = row_count;
  return jsonb_build_object('state_links', v_links);
end;
$$;

revoke all on function public.refresh_derived() from public, anon, authenticated;
grant execute on function public.refresh_derived() to service_role;

-- --------------------------------------------------------- the compiler

create or replace function public.compile_questions(p_template_slug text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t record;
  rec record;
  d record;
  v_text text;
  v_key text;
  v_family text;
  v_aliases text[];
  v_norm_answers text[];
  v_options text[];
  v_norm text;
  v_tier integer;
  v_templates integer := 0;
  v_seen integer := 0;
  v_written integer := 0;
  v_skipped_lint integer := 0;
  v_skipped_unverified integer := 0;
  v_errors integer := 0;
begin
  for t in
    select * from facts.question_templates
    where enabled and (p_template_slug is null or slug = p_template_slug)
    order by slug
  loop
    v_templates := v_templates + 1;
    begin
      for rec in execute format(
        'select family_entity::text, territory_id::text, params, answer::text,
                aliases, prominence::numeric, fact_refs, verified
         from (%s) answer_rows', t.answer_sql)
      loop
        v_seen := v_seen + 1;

        -- Gate B: unverified facts never become questions.
        if rec.verified is distinct from true then
          v_skipped_unverified := v_skipped_unverified + 1;
          continue;
        end if;

        -- Gate A: structural lint.
        if rec.answer is null or length(trim(rec.answer)) = 0
           or rec.territory_id is null
           or not exists (select 1 from public.territories where id = rec.territory_id) then
          v_skipped_lint := v_skipped_lint + 1;
          continue;
        end if;

        v_text := t.text_template;
        for v_key in select jsonb_object_keys(coalesce(rec.params, '{}'::jsonb)) loop
          v_text := replace(v_text, '{' || v_key || '}', coalesce(rec.params ->> v_key, ''));
        end loop;
        if v_text like '%{%' or length(v_text) > 300
           or position(lower(rec.answer) in lower(v_text)) > 0 then
          v_skipped_lint := v_skipped_lint + 1;
          continue;
        end if;

        -- Alias set: answer first, then variants, deduped by normalization.
        v_aliases := array[rec.answer];
        v_norm_answers := array[public.normalize_answer(rec.answer)];
        for d in
          select public.normalize_answer(a) as norm, a as alias
          from unnest(coalesce(rec.aliases, '{}'::text[])) as a
          where a is not null and length(a) between 1 and 80
        loop
          if d.norm <> '' and not d.norm = any (v_norm_answers) then
            v_aliases := v_aliases || d.alias;
            v_norm_answers := v_norm_answers || d.norm;
          end if;
        end loop;

        -- Options: the answer plus distractors no grader would accept.
        v_options := array[rec.answer];
        if t.format = 'multiple_choice' then
          if t.distractor_sql is null then
            v_skipped_lint := v_skipped_lint + 1;
            continue;
          end if;
          for d in execute format('select candidate::text from (%s) distractor_rows', t.distractor_sql)
            using rec.params
          loop
            exit when array_length(v_options, 1) >= t.option_count;
            v_norm := public.normalize_answer(d.candidate);
            if v_norm = '' or d.candidate is null or length(d.candidate) > 80 then
              continue;
            end if;
            -- Reject anything answer_matches() could grade as correct:
            -- exact/alias hits, or fuzzy hits on longer strings.
            if v_norm = any (v_norm_answers) then
              continue;
            end if;
            if exists (
              select 1 from unnest(v_norm_answers) as accepted(n)
              where char_length(v_norm) > 6
                and levenshtein_less_equal(v_norm, accepted.n, 2) <= 2
            ) then
              continue;
            end if;
            if exists (
              select 1 from unnest(v_options) as chosen(o)
              where public.normalize_answer(chosen.o) = v_norm
            ) then
              continue;
            end if;
            v_options := v_options || d.candidate;
          end loop;
          if array_length(v_options, 1) < t.option_count then
            v_skipped_lint := v_skipped_lint + 1;
            continue;
          end if;
        end if;

        -- Tier: template base nudged by prominence, clamped to the format's
        -- native band (MC 1-2, free-fill 2-3) so game feel stays consistent.
        v_tier := t.tier_base
          + case when coalesce(rec.prominence, 0.4) < 0.22 then 1
                 when coalesce(rec.prominence, 0.4) > 0.72 then -1
                 else 0 end;
        if t.format = 'multiple_choice' then
          v_tier := least(2, greatest(1, v_tier));
        else
          v_tier := least(3, greatest(2, v_tier));
        end if;

        v_family := t.slug || ':' || rec.family_entity;
        insert into public.questions(
          territory_id, sport, link_type, tier, format, question_text,
          options, correct_answer, aliases, validation_status, active,
          template_id, fact_refs, family_key, prominence)
        values (
          rec.territory_id, t.sport, t.link_type, v_tier, t.format, v_text,
          case when t.format = 'multiple_choice' then to_jsonb(v_options) else '[]'::jsonb end,
          rec.answer, v_aliases, 'generated_v1', true,
          t.id, rec.fact_refs, v_family, rec.prominence)
        on conflict (template_id, family_key) where template_id is not null
        do update set
          territory_id = excluded.territory_id,
          tier = excluded.tier,
          question_text = excluded.question_text,
          options = excluded.options,
          correct_answer = excluded.correct_answer,
          aliases = excluded.aliases,
          fact_refs = excluded.fact_refs,
          prominence = excluded.prominence;
        v_written := v_written + 1;
      end loop;
    exception when others then
      v_errors := v_errors + 1;
      insert into facts.fact_conflicts(entity_type, entity_id, field, kind, detail)
      values ('template', t.slug, 'compile', 'template_error',
              jsonb_build_object('error', sqlerrm));
    end;
  end loop;

  return jsonb_build_object(
    'templates', v_templates,
    'instances_seen', v_seen,
    'written', v_written,
    'skipped_lint', v_skipped_lint,
    'skipped_unverified', v_skipped_unverified,
    'template_errors', v_errors);
end;
$$;

revoke all on function public.compile_questions(text) from public, anon, authenticated;
grant execute on function public.compile_questions(text) to service_role;

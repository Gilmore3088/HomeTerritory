-- Phase 3, P3b task 4a: the cross-verification job.
--
-- Two independent sources asserting the same fact is the strongest
-- provenance the warehouse has, stronger than either alone. Nightly,
-- before compiling, this job:
--   * matches Wikidata athletes to Lahman athletes (normalized name plus
--     an exact birth-date hit, or debut years within two) and, when the
--     match is UNIQUE in both directions and the facts agree, promotes
--     both rows to 'cross_verified' with both sources recorded;
--   * files facts.fact_conflicts instead wherever the sources DISAGREE
--     (kind 'value_conflict': same person, different birth state/city) or
--     the match is AMBIGUOUS (kind 'unresolved_entity': two Lahman "Frank
--     Thomas" rows both plausible) -- a conflicted or ambiguous fact is
--     never promoted, and each conflict is filed once until resolved;
--   * cross-checks World Series titles between Wikidata championships and
--     Lahman season results by year: agreeing winners promote both rows,
--     disagreeing winners are a value_conflict on the championship.
-- ESPN events get their promotion path later, against the official MLB
-- statsapi / NHL api-web feeds (owner-keyed backlog): single_source until
-- then, by design.

create or replace function public.cross_verify_facts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ath_promoted integer := 0;
  v_ath_conflicts integer := 0;
  v_ath_ambiguous integer := 0;
  v_champ_promoted integer := 0;
  v_champ_conflicts integer := 0;
begin
  -- ------------------------------------------------------------ athletes
  drop table if exists xv_pairs;
  create temp table xv_pairs on commit drop as
  select w.id as wid, l.id as lid,
         w.birth_state as w_state, l.birth_state as l_state,
         w.birth_city as w_city, l.birth_city as l_city,
         count(*) over (partition by w.id) as w_matches,
         count(*) over (partition by l.id) as l_matches
  from facts.athletes w
  join facts.athletes l
    on w.source = 'wikidata' and l.source = 'lahman'
   and public.normalize_answer(w.full_name) = public.normalize_answer(l.full_name)
   and (
     (w.birth_date is not null and w.birth_date = l.birth_date)
     or (w.career_start is not null and l.career_start is not null
         and abs(w.career_start - l.career_start) <= 2)
   );

  -- Ambiguous matches: same name resolving to several people. File once,
  -- promote nothing.
  insert into facts.fact_conflicts(entity_type, entity_id, field, kind, detail)
  select distinct 'athlete', p.wid, 'identity', 'unresolved_entity',
         jsonb_build_object('lahman_candidates',
           (select jsonb_agg(p2.lid) from xv_pairs p2 where p2.wid = p.wid))
  from xv_pairs p
  where (p.w_matches > 1 or p.l_matches > 1)
    and not exists (
      select 1 from facts.fact_conflicts fc
      where fc.entity_type = 'athlete' and fc.entity_id = p.wid
        and fc.field = 'identity' and fc.kind = 'unresolved_entity'
        and fc.resolved_at is null
    );
  get diagnostics v_ath_ambiguous = row_count;

  -- Disagreements on a uniquely matched person: a conflict, not a promotion.
  insert into facts.fact_conflicts(entity_type, entity_id, field, source_a, value_a, source_b, value_b, kind, detail)
  select 'athlete', p.wid,
         case when p.w_state is distinct from p.l_state then 'birth_state' else 'birth_city' end,
         'wikidata',
         case when p.w_state is distinct from p.l_state then p.w_state else p.w_city end,
         'lahman',
         case when p.w_state is distinct from p.l_state then p.l_state else p.l_city end,
         'value_conflict',
         jsonb_build_object('lahman_id', p.lid)
  from xv_pairs p
  where p.w_matches = 1 and p.l_matches = 1
    and ((p.w_state is not null and p.l_state is not null and p.w_state <> p.l_state)
      or (p.w_city is not null and p.l_city is not null
          and public.normalize_answer(p.w_city) <> public.normalize_answer(p.l_city)))
    and not exists (
      select 1 from facts.fact_conflicts fc
      where fc.entity_type = 'athlete' and fc.entity_id = p.wid
        and fc.kind = 'value_conflict' and fc.resolved_at is null
    );
  get diagnostics v_ath_conflicts = row_count;

  -- Clean, unique agreement: the promotion.
  update facts.athletes a
  set confidence = 'cross_verified',
      verified_sources = (
        select array_agg(distinct s order by s)
        from unnest(coalesce(a.verified_sources, '{}') || array['wikidata', 'lahman']) as s
      )
  from xv_pairs p
  where a.id in (p.wid, p.lid)
    and p.w_matches = 1 and p.l_matches = 1
    and (p.w_state is null or p.l_state is null or p.w_state = p.l_state)
    and (p.w_city is null or p.l_city is null
         or public.normalize_answer(p.w_city) = public.normalize_answer(p.l_city))
    and a.confidence <> 'cross_verified';
  get diagnostics v_ath_promoted = row_count;

  -- ------------------------------------------------------- championships
  drop table if exists xv_champs;
  create temp table xv_champs on commit drop as
  select ch.id as chid, sr.id as srid,
         public.normalize_answer(ch.winner_name) = public.normalize_answer(sr.team_name) as agree,
         ch.winner_name as wd_winner, sr.team_name as lahman_winner
  from facts.championships ch
  join facts.season_results sr
    on ch.league = 'MLB' and ch.season ilike '%world series%'
   and sr.source = 'lahman' and sr.playoff_result = 'won World Series'
   and sr.year = ch.year
  where ch.source = 'wikidata';

  insert into facts.fact_conflicts(entity_type, entity_id, field, source_a, value_a, source_b, value_b, kind, detail)
  select 'championship', c.chid, 'winner', 'wikidata', c.wd_winner, 'lahman', c.lahman_winner,
         'value_conflict', jsonb_build_object('season_result_id', c.srid)
  from xv_champs c
  where not c.agree
    and not exists (
      select 1 from facts.fact_conflicts fc
      where fc.entity_type = 'championship' and fc.entity_id = c.chid
        and fc.kind = 'value_conflict' and fc.resolved_at is null
    );
  get diagnostics v_champ_conflicts = row_count;

  update facts.championships ch
  set confidence = 'cross_verified',
      verified_sources = (
        select array_agg(distinct s order by s)
        from unnest(coalesce(ch.verified_sources, '{}') || array['wikidata', 'lahman']) as s
      )
  from xv_champs c
  where ch.id = c.chid and c.agree and ch.confidence <> 'cross_verified';
  get diagnostics v_champ_promoted = row_count;

  update facts.season_results sr
  set confidence = 'cross_verified',
      verified_sources = (
        select array_agg(distinct s order by s)
        from unnest(coalesce(sr.verified_sources, '{}') || array['wikidata', 'lahman']) as s
      )
  from xv_champs c
  where sr.id = c.srid and c.agree and sr.confidence <> 'cross_verified';

  return jsonb_build_object(
    'athletes_promoted', v_ath_promoted,
    'athletes_conflicted', v_ath_conflicts,
    'athletes_ambiguous', v_ath_ambiguous,
    'championships_promoted', v_champ_promoted,
    'championships_conflicted', v_champ_conflicts);
end;
$$;

revoke all on function public.cross_verify_facts() from public, anon, authenticated;
grant execute on function public.cross_verify_facts() to service_role;

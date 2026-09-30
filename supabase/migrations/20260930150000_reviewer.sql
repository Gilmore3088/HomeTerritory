-- Phase 3, P3c-2: the human review surface.
--
-- Gate C files advisory flags and players file reports; someone has to act
-- on them. profiles.is_reviewer marks who may (the owner flips it in the
-- SQL editor -- deliberately not self-service and not a commissioner
-- power, since questions are shared across every league).
--
-- Two RPCs back the /review page. Both are security definer and granted to
-- authenticated, with the reviewer check inside, so a reviewer uses their
-- ordinary session; non-reviewers get a refusal, not data.
--   review_queue(): generated questions most in need of eyes -- unresolved
--     Gate C flags first, then player-reported, then telemetry-retired,
--     then the newest untouched compiles.
--   review_decide(): 'approve' promotes validation_status to 'reviewed_v1'
--     (and reactivates + clears reports/flags -- the human outranks the
--     machines); 'retire' deactivates with retired_reason 'reviewer'.
--     Recompiles never resurrect either (the upsert leaves active alone,
--     and validation_status only changes on insert).

alter table public.profiles add column is_reviewer boolean not null default false;

create or replace function public.review_queue(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_reviewer) then
    raise exception 'Not a reviewer';
  end if;

  select coalesce(jsonb_agg(row_to_json(queue)), '[]'::jsonb) into v_rows
  from (
    select q.id, q.territory_id, q.sport, q.tier, q.format, q.question_text,
           q.options, q.correct_answer, q.aliases, q.active, q.retired_reason,
           q.validation_status, q.attempt_count, q.correct_count,
           coalesce((
             select jsonb_agg(fc.detail -> 'issues')
             from facts.fact_conflicts fc
             where fc.kind = 'gate_c_flag'
               and fc.entity_id = q.id::text
               and fc.resolved_at is null
           ), '[]'::jsonb) as gate_c_issues,
           (select count(*) from public.question_reports r where r.question_id = q.id) as report_count
    from public.questions q
    where q.template_id is not null
      and q.validation_status = 'generated_v1'
      -- A reviewer's retire is final for the queue; it must not cycle back.
      and q.retired_reason is distinct from 'reviewer'
    order by
      (exists (select 1 from facts.fact_conflicts fc
               where fc.kind = 'gate_c_flag' and fc.entity_id = q.id::text
                 and fc.resolved_at is null)) desc,
      (select count(*) from public.question_reports r where r.question_id = q.id) desc,
      (q.retired_reason is not null) desc,
      q.created_at desc
    limit greatest(1, least(p_limit, 100))
  ) queue;

  return v_rows;
end;
$$;

revoke all on function public.review_queue(integer) from public, anon;
grant execute on function public.review_queue(integer) to authenticated, service_role;

create or replace function public.review_decide(
  p_question_id uuid,
  p_verdict text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_question public.questions;
  v_flags integer;
  v_reports integer;
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_reviewer) then
    raise exception 'Not a reviewer';
  end if;
  if p_verdict not in ('approve', 'retire') then
    raise exception 'Verdict must be approve or retire';
  end if;

  select q.* into v_question from public.questions q where q.id = p_question_id for update;
  if not found then raise exception 'Question not found'; end if;
  if v_question.template_id is null then
    raise exception 'Handwritten questions go through the report flow, not review';
  end if;

  update facts.fact_conflicts fc
  set resolved_at = now(),
      resolution = p_verdict || ' by reviewer' || coalesce(': ' || nullif(trim(p_note), ''), '')
  where fc.kind = 'gate_c_flag'
    and fc.entity_id = p_question_id::text
    and fc.resolved_at is null;
  get diagnostics v_flags = row_count;

  if p_verdict = 'approve' then
    select count(*) into v_reports from public.question_reports r where r.question_id = p_question_id;
    delete from public.question_reports r where r.question_id = p_question_id;
    update public.questions
    set active = true,
        retired_reason = null,
        validation_status = 'reviewed_v1'
    where id = p_question_id;
  else
    v_reports := 0;
    update public.questions
    set active = false,
        retired_reason = 'reviewer'
    where id = p_question_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'question_id', p_question_id,
    'verdict', p_verdict,
    'flags_resolved', v_flags,
    'reports_cleared', v_reports
  );
end;
$$;

revoke all on function public.review_decide(uuid, text, text) from public, anon;
grant execute on function public.review_decide(uuid, text, text) to authenticated, service_role;

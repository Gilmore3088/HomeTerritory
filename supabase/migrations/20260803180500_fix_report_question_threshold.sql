-- Finding 9: a single report set `questions.active = false` globally, with no
-- threshold, no reviewer and no per-season scoping. The bank holds only 11
-- questions per state and every league shares it, so a handful of reports --
-- or one account reporting repeatedly, which nothing prevented -- permanently
-- stripped a state's trivia from the whole product.
--
-- A report now needs three distinct reporters before it quarantines a question,
-- and one account counts once. The reporter still gets the session voided and
-- the move refunded on their first report, so nothing about reporting a genuinely
-- broken question got slower.

delete from public.question_reports a
using public.question_reports b
where a.question_id = b.question_id
  and a.reported_by = b.reported_by
  and a.ctid > b.ctid;

create unique index if not exists question_reports_one_per_reporter
  on public.question_reports(question_id, reported_by);

-- Repair questions an under-threshold report already knocked out. Scoped to rows
-- that actually carry a report, so anything disabled by hand stays disabled.
update public.questions q
set active = true
where not q.active
  and exists (select 1 from public.question_reports r where r.question_id = q.id)
  and (select count(distinct r.reported_by) from public.question_reports r where r.question_id = q.id) < 3;

create or replace function public.report_question(p_attempt_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_quarantine_threshold constant integer := 3;
  v_attempt public.question_attempts;
  v_session public.game_sessions;
  v_reporters integer;
begin
  select * into v_attempt from public.question_attempts where id = p_attempt_id for update;
  if not found or v_attempt.user_id <> auth.uid() then raise exception 'Attempt not found'; end if;
  select * into v_session from public.game_sessions where id = v_attempt.session_id for update;
  if v_session.status <> 'active' then raise exception 'This session is already resolved'; end if;

  insert into public.question_reports(question_id, attempt_id, reported_by, reason)
  values (v_attempt.question_id, v_attempt.id, auth.uid(), left(coalesce(p_reason, 'Question reported'), 500))
  on conflict (question_id, reported_by) do nothing;

  select count(distinct reported_by) into v_reporters
  from public.question_reports
  where question_id = v_attempt.question_id;

  if v_reporters >= c_quarantine_threshold then
    update public.questions set active = false where id = v_attempt.question_id;
  end if;

  update public.question_attempts set answered_at = now(), answer_text = '[reported]' where id = v_attempt.id;
  update public.game_sessions set status = 'void' where id = v_session.id;

  -- Fortify spends a move too (finding 4), so it is refunded like the rest. The
  -- old `delete from fortify_log` branch is gone: since finding 8 the log row is
  -- written by the winning answer, so an active fortify session never has one.
  if v_session.action_type in ('claim', 'attack', 'fortify') then
    update public.player_actions set actions_remaining = least(5, actions_remaining + 1), updated_at = now()
    where season_id = v_session.season_id and user_id = auth.uid();
  end if;

  return jsonb_build_object(
    'status', 'void',
    'message', case when v_reporters >= c_quarantine_threshold
      then 'Question quarantined and move refunded.'
      else 'Report filed and move refunded. Thanks.' end,
    'reports', v_reporters
  );
end;
$$;

-- Question quarantine has been one-way since finding 9: three distinct
-- reporters set `questions.active = false` and nothing in the schema could
-- ever undo it (backlog P3). `reactivate_question` is the undo: it clears
-- the question's reports (so the same three accounts re-reporting start a
-- fresh count) and reactivates it.
--
-- Deliberately service-role only. Review is an operator decision made after
-- reading the reports; no player or commissioner surface should flip a
-- shared, cross-league question back on. Callable from the Supabase SQL
-- editor / a server route under the secret key.
create or replace function public.reactivate_question(p_question_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active boolean;
  v_reports integer;
begin
  select active into v_active from public.questions where id = p_question_id for update;
  if not found then raise exception 'Question not found'; end if;

  select count(*) into v_reports from public.question_reports where question_id = p_question_id;
  delete from public.question_reports where question_id = p_question_id;
  update public.questions set active = true where id = p_question_id;

  return jsonb_build_object(
    'ok', true,
    'question_id', p_question_id,
    'was_active', v_active,
    'reports_cleared', v_reports
  );
end;
$$;

revoke all on function public.reactivate_question(uuid) from public, anon, authenticated;
grant execute on function public.reactivate_question(uuid) to service_role;

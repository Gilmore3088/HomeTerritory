revoke all on function public.generate_league_recap(uuid,date) from public,anon,authenticated;
grant execute on function public.generate_league_recap(uuid,date) to service_role;

revoke all on function public.generate_due_recaps() from public,anon,authenticated;
grant execute on function public.generate_due_recaps() to service_role;

revoke all on function public.run_test_bot_turns(uuid) from public,anon,authenticated;
grant execute on function public.run_test_bot_turns(uuid) to service_role;

revoke all on function public.get_latest_group_recap(uuid) from public,anon;
grant execute on function public.get_latest_group_recap(uuid) to authenticated,service_role;

create or replace function public.test_submit_answer(p_session_id uuid,p_correct boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.game_sessions;
  v_group_id uuid;
  v_answer text;
begin
  select * into v_session
  from public.game_sessions
  where id=p_session_id;

  if not found or v_session.user_id<>auth.uid() then raise exception 'Test session not found'; end if;

  select s.group_id into v_group_id
  from public.seasons s
  where s.id=v_session.season_id;

  if not exists(select 1 from public.e2e_runs r where r.group_id=v_group_id) then
    raise exception 'Automated answers are restricted to isolated E2E fixtures';
  end if;

  if p_correct then
    select q.correct_answer into v_answer
    from public.question_attempts qa
    join public.questions q on q.id=qa.question_id
    where qa.id=v_session.current_attempt_id;
  else
    v_answer:='__territory_e2e_intentional_miss__';
  end if;

  return public.game_submit_answer(p_session_id,v_answer);
end;
$$;

revoke all on function public.test_submit_answer(uuid,boolean) from public,anon;
grant execute on function public.test_submit_answer(uuid,boolean) to authenticated,service_role;

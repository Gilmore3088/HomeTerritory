create or replace function public.report_question(p_attempt_id uuid,p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.question_attempts;
  v_session public.game_sessions;
begin
  select * into v_attempt
  from public.question_attempts
  where id=p_attempt_id
  for update;

  if not found or v_attempt.user_id<>auth.uid() then raise exception 'Attempt not found'; end if;

  select * into v_session
  from public.game_sessions
  where id=v_attempt.session_id
  for update;

  if v_session.status<>'active' then raise exception 'This session is already resolved'; end if;

  update public.questions set active=false where id=v_attempt.question_id;

  insert into public.question_reports(question_id,attempt_id,reported_by,reason)
  values(v_attempt.question_id,v_attempt.id,auth.uid(),left(coalesce(p_reason,'Question reported'),500));

  update public.question_attempts
  set answered_at=now(),answer_text='[reported]'
  where id=v_attempt.id;

  update public.game_sessions set status='void' where id=v_session.id;

  if v_session.action_type in ('claim','attack','fortify') then
    update public.player_actions
    set actions_remaining=least(3,actions_remaining+1),updated_at=now()
    where season_id=v_session.season_id and user_id=auth.uid();
  end if;

  if v_session.action_type='fortify' then
    delete from public.fortify_log
    where season_id=v_session.season_id
      and territory_id=v_session.territory_id
      and user_id=auth.uid()
      and played_on=current_date;
  end if;

  return jsonb_build_object('status','void','message','Question quarantined and move refunded.');
end;
$$;

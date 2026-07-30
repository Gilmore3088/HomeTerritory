-- Audit fixes (docs/repo-audit-2026-07-30.md):
-- #1 Resumed questions leaked the correct answer: options were stored with the
--    correct answer first and only shuffled at serve time. Shuffle is now
--    deterministic per attempt, so serving and resuming agree and reveal nothing.
-- #4 Home-ground re-roll loophole: a timed-out home session never set
--    home_completed, allowing unlimited retries. Timeouts now settle home
--    ground, and a second concurrent home session can no longer be opened.

create or replace function public.pick_next_question(p_session_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_session public.game_sessions;
  v_question public.questions;
  v_attempt uuid;
  v_expires timestamptz;
  v_options jsonb;
  v_sports text[];
begin
  select gs.* into v_session from public.game_sessions gs where gs.id = p_session_id for update;
  select g.sports into v_sports from public.seasons s join public.groups g on g.id = s.group_id where s.id = v_session.season_id;

  select q.* into v_question
  from public.questions q
  where q.territory_id = v_session.territory_id
    and q.active
    and not exists(select 1 from public.season_question_seen sqs where sqs.season_id = v_session.season_id and sqs.question_id = q.id)
  order by case when q.sport = any(v_sports) then 0 else 1 end, abs(q.tier - v_session.tier), random()
  limit 1;

  if not found then raise exception 'This state is temporarily out of unused questions'; end if;
  insert into public.season_question_seen(season_id, question_id, served_to) values (v_session.season_id, v_question.id, v_session.user_id);
  v_expires := now() + case when v_question.tier = 3 then interval '45 seconds' else interval '30 seconds' end;
  insert into public.question_attempts(session_id, question_id, user_id, expires_at)
  values (p_session_id, v_question.id, v_session.user_id, v_expires) returning id into v_attempt;
  update public.game_sessions set current_attempt_id = v_attempt where id = p_session_id;

  -- Deterministic per-attempt shuffle: stable across resumes, never the stored order.
  select coalesce(jsonb_agg(value order by md5(value || v_attempt::text)), '[]'::jsonb) into v_options
  from jsonb_array_elements_text(v_question.options);

  return jsonb_build_object(
    'attempt_id', v_attempt,
    'text', v_question.question_text,
    'format', v_question.format,
    'options', v_options,
    'tier', v_question.tier,
    'sport', v_question.sport,
    'link_type', v_question.link_type,
    'expires_at', v_expires
  );
end;
$$;

create or replace function public.get_my_active_session(p_group_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_season uuid;
  v_session public.game_sessions;
  v_attempt public.question_attempts;
  v_question public.questions;
  v_options jsonb;
begin
  if not public.is_group_member(p_group_id,auth.uid()) then raise exception 'Group access denied'; end if;
  select id into v_season from public.seasons where group_id=p_group_id and status='active' order by created_at desc limit 1;
  if v_season is null then return null; end if;
  perform public.resolve_expired_sessions(v_season);
  select * into v_session from public.game_sessions where season_id=v_season and user_id=auth.uid() and status='active' order by created_at desc limit 1;
  if not found then return null; end if;
  select * into v_attempt from public.question_attempts where id=v_session.current_attempt_id and answered_at is null;
  if not found then return null; end if;
  select * into v_question from public.questions where id=v_attempt.question_id;

  -- Same per-attempt shuffle as pick_next_question; the raw column order put
  -- the correct answer first, which a page refresh used to reveal.
  select coalesce(jsonb_agg(value order by md5(value || v_attempt.id::text)), '[]'::jsonb) into v_options
  from jsonb_array_elements_text(v_question.options);

  return jsonb_build_object(
    'session_id',v_session.id,'action_type',v_session.action_type,'territory_id',v_session.territory_id,
    'required_correct',v_session.required_correct,'correct_count',v_session.correct_count,
    'question',jsonb_build_object('attempt_id',v_attempt.id,'text',v_question.question_text,'format',v_question.format,'options',v_options,'tier',v_question.tier,'sport',v_question.sport,'link_type',v_question.link_type,'expires_at',v_attempt.expires_at)
  );
end;
$$;

create or replace function public.resolve_expired_sessions(p_season_id uuid default null)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_row record;
  v_count integer := 0;
  v_state_name text;
  v_player_name text;
begin
  for v_row in
    select gs.id, gs.season_id, gs.territory_id, gs.user_id, gs.action_type, gs.attack_id, qa.id as attempt_id
    from public.game_sessions gs
    join public.question_attempts qa on qa.id = gs.current_attempt_id
    where gs.status = 'active' and qa.answered_at is null and qa.expires_at <= now()
      and (p_season_id is null or gs.season_id = p_season_id)
    for update of gs, qa skip locked
  loop
    update public.question_attempts set answer_text = '[timeout]', is_correct = false, answered_at = now() where id = v_row.attempt_id;
    update public.game_sessions set status = 'failed' where id = v_row.id;
    if v_row.action_type = 'claim' then
      insert into public.cooldowns(season_id, territory_id, user_id, action_type, expires_at)
      values (v_row.season_id, v_row.territory_id, v_row.user_id, 'claim', now() + interval '6 hours')
      on conflict (season_id, territory_id, user_id, action_type) do update set expires_at = excluded.expires_at;
    elsif v_row.action_type = 'defend' then
      perform public.resolve_attack_win(v_row.attack_id, 'incorrect');
    elsif v_row.action_type = 'home' then
      -- A timed-out home question settles home ground exposed, exactly like a
      -- wrong answer. Otherwise timing out is a free re-roll of the question.
      update public.group_members gm set home_completed = true
      from public.seasons s
      where s.id = v_row.season_id and gm.group_id = s.group_id and gm.user_id = v_row.user_id;
    end if;
    select name into v_state_name from public.territories where id = v_row.territory_id;
    select display_name into v_player_name from public.profiles where id = v_row.user_id;
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_row.season_id, v_row.user_id, 'answer_timed_out', v_row.territory_id, format('%s ran out of time in %s.', v_player_name, v_state_name));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.game_begin_action(
  p_season_id uuid,
  p_territory_id text,
  p_action_type text,
  p_attack_id uuid default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid:=auth.uid(); v_season public.seasons; v_state public.season_territories; v_attack public.attacks;
  v_session uuid; v_required integer:=1; v_tier integer:=1; v_actions integer; v_leader integer; v_player_score integer;
  v_owner_count integer; v_is_adjacent boolean; v_question jsonb; v_home text; v_home_done boolean; v_diff text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_season from public.seasons where id=p_season_id and status='active';
  if not found then raise exception 'Active season not found'; end if;
  if not public.is_group_member(v_season.group_id,v_user) then raise exception 'You are not in this group'; end if;
  perform public.resolve_expired_sessions(p_season_id); perform public.resolve_expired_attacks(p_season_id);
  select * into v_state from public.season_territories where season_id=p_season_id and territory_id=p_territory_id for update;
  if not found then raise exception 'Territory not found'; end if;
  select difficulty into v_diff from public.groups where id=v_season.group_id;
  select count(*) into v_owner_count from public.season_territories where season_id=p_season_id and owner_id=v_user;
  select exists(select 1 from public.season_territories st join public.territories t on t.id=st.territory_id where st.season_id=p_season_id and st.owner_id=v_user and p_territory_id=any(t.adjacent)) into v_is_adjacent;

  if p_action_type in ('claim','attack') then
    v_actions:=public.refresh_player_actions(p_season_id,v_user); if v_actions<1 then raise exception 'No attack actions remaining'; end if;
  end if;

  if p_action_type='home' then
    select home_state,home_completed into v_home,v_home_done from public.group_members where group_id=v_season.group_id and user_id=v_user;
    if v_home is null or v_home<>p_territory_id then raise exception 'Choose your home state'; end if;
    if v_home_done then raise exception 'Home ground is already settled'; end if;
    if v_state.owner_id<>v_user then raise exception 'Home ground ownership is missing'; end if;
    if exists(select 1 from public.game_sessions where season_id=p_season_id and user_id=v_user and action_type='home' and status='active') then raise exception 'Your home question is already in play'; end if;
    v_required:=1; v_tier:=2;
  elsif p_action_type='claim' then
    if v_state.owner_id is not null or v_state.contested then raise exception 'This state is not neutral'; end if;
    if v_owner_count>0 and not v_is_adjacent then raise exception 'You must claim an adjacent state'; end if;
    if exists(select 1 from public.cooldowns where season_id=p_season_id and territory_id=p_territory_id and user_id=v_user and action_type='claim' and expires_at>now()) then raise exception 'This state is cooling down'; end if;
    update public.player_actions set actions_remaining=actions_remaining-1,updated_at=now() where season_id=p_season_id and user_id=v_user;
    v_required:=1;v_tier:=1;
  elsif p_action_type='attack' then
    if v_state.owner_id is null or v_state.owner_id=v_user then raise exception 'Choose another player''s state'; end if;
    if v_state.contested or exists(select 1 from public.attacks where season_id=p_season_id and territory_id=p_territory_id and status='contested') then raise exception 'This state is already contested'; end if;
    if v_owner_count>0 and not v_is_adjacent then raise exception 'You must attack an adjacent state'; end if;
    v_required:=case when v_state.hold_level=1 then 2 else 3 end;
    if v_diff='casual' then v_required:=greatest(1,v_required-1); elsif v_diff='hardcore' then v_required:=v_required+1; end if;
    v_tier:=case when v_state.hold_level=3 then 3 else 2 end;
    select coalesce(max(cumulative_score),0) into v_leader from public.player_actions where season_id=p_season_id;
    select cumulative_score into v_player_score from public.player_actions where season_id=p_season_id and user_id=v_user;
    if v_leader>0 and v_player_score<v_leader*.60 then v_required:=greatest(1,v_required-1); end if;
    update public.player_actions set actions_remaining=actions_remaining-1,updated_at=now() where season_id=p_season_id and user_id=v_user;
  elsif p_action_type='fortify' then
    if v_state.owner_id<>v_user then raise exception 'You do not own this state'; end if;
    if v_state.contested then raise exception 'A contested state cannot be fortified'; end if;
    if v_state.hold_level>=3 then raise exception 'This state is already fully fortified'; end if;
    insert into public.fortify_log(season_id,territory_id,user_id) values(p_season_id,p_territory_id,v_user) on conflict do nothing;
    if not found then raise exception 'You already fortified this state today'; end if;
    v_required:=1;v_tier:=least(v_state.hold_level,2);
  elsif p_action_type='defend' then
    select * into v_attack from public.attacks where id=p_attack_id and season_id=p_season_id and territory_id=p_territory_id for update;
    if not found or v_attack.status<>'contested' then raise exception 'Active attack not found'; end if;
    if v_attack.defender_id<>v_user then raise exception 'Only the owner can defend'; end if;
    if v_attack.defense_deadline<=now() then perform public.resolve_attack_win(v_attack.id,'timeout');raise exception 'The defense window expired'; end if;
    if exists(select 1 from public.game_sessions where attack_id=v_attack.id and action_type='defend' and status in ('active','completed','failed')) then raise exception 'This defense has already been played'; end if;
    v_required:=1;v_tier:=v_attack.tier;
  else raise exception 'Invalid action type'; end if;

  insert into public.game_sessions(season_id,territory_id,user_id,action_type,attack_id,required_correct,tier)
  values(p_season_id,p_territory_id,v_user,p_action_type,p_attack_id,v_required,v_tier) returning id into v_session;
  v_question:=public.pick_next_question(v_session);
  return jsonb_build_object('session_id',v_session,'action_type',p_action_type,'territory_id',p_territory_id,'question',v_question,'required_correct',v_required,'correct_count',0);
end;
$$;

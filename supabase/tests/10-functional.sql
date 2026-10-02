-- Functional tests for the SQL game engine, run in CI after the migration
-- chain has been applied on top of 00-shim.sql. auth.uid() is simulated by
-- setting the request.jwt.claim.sub GUC. Raises an exception on any failure.
do $$
declare
  v_g uuid; v_code text; v_season uuid; v_res jsonb; v_res2 jsonb; v_err text;
  u1 uuid := '00000000-0000-0000-0000-000000000001';
  u2 uuid := '00000000-0000-0000-0000-000000000002';
  u3 uuid := '00000000-0000-0000-0000-000000000003';
  v_done boolean; v_opts1 jsonb; v_opts2 jsonb;
begin
  insert into auth.users(id,email) values (u1,'a@x.com'),(u2,'b@x.com'),(u3,'c@x.com');

  -- create_group_v2 rejects malformed sports (audit hardening).
  perform set_config('request.jwt.claim.sub', u1::text, true);
  v_err := null;
  begin
    v_g := public.create_group_v2('Bad League', array['NFL', ''], 14, 'open', 'fifty', 'standard', true);
    v_err := 'no-error';
  exception when others then v_err := sqlerrm; end;
  if v_err = 'no-error' then raise exception 'FAIL: empty sport name accepted';
  elsif v_err like '%Invalid sport%' then raise notice 'PASS empty sport name rejected';
  else raise exception 'unexpected error: %', v_err; end if;

  -- Lobby: create, join, pick home states, start.
  v_g := public.create_group_v2('Audit League', array['NFL'], 14, 'open', 'fifty', 'standard', true);
  select invite_code into v_code from public.groups where id = v_g;
  perform set_config('request.jwt.claim.sub', u2::text, true);
  perform public.join_group(v_code);
  perform set_config('request.jwt.claim.sub', u3::text, true);
  perform public.join_group(v_code);
  perform set_config('request.jwt.claim.sub', u1::text, true);
  perform public.set_home_state(v_g, 'WA');
  perform set_config('request.jwt.claim.sub', u2::text, true);
  perform public.set_home_state(v_g, 'TX');
  perform set_config('request.jwt.claim.sub', u3::text, true);
  perform public.set_home_state(v_g, 'FL');
  perform set_config('request.jwt.claim.sub', u1::text, true);
  v_season := public.start_season(v_g);
  raise notice 'season started';

  -- Home question begins; a duplicate concurrent home session is blocked.
  v_res := public.game_begin_action(v_season, 'WA', 'home', null);
  v_err := null;
  begin
    v_res2 := public.game_begin_action(v_season, 'WA', 'home', null);
    v_err := 'no-error';
  exception when others then v_err := sqlerrm; end;
  if v_err = 'no-error' then raise exception 'FAIL: duplicate home session allowed';
  elsif v_err like '%already in play%' then raise notice 'PASS duplicate home session blocked';
  else raise exception 'unexpected error: %', v_err; end if;

  -- Resuming a question is deterministic and matches the served option order,
  -- so a page refresh can never reveal the stored (answer-first) order.
  v_res2 := public.get_my_active_session(v_g);
  v_opts1 := v_res2->'question'->'options';
  v_res2 := public.get_my_active_session(v_g);
  v_opts2 := v_res2->'question'->'options';
  if v_opts1 <> v_opts2 then raise exception 'FAIL resume options differ between calls'; end if;
  if v_opts1 <> (v_res->'question'->'options') then raise exception 'FAIL resume order differs from served order'; end if;
  raise notice 'PASS resume options deterministic and equal to served order';

  -- Seen-tracking is per player: the question u1 drew must remain insertable
  -- (and thus servable) for u2.
  insert into public.season_question_seen(season_id, question_id, served_to)
  select season_id, question_id, u2 from public.season_question_seen where served_to = u1 limit 1;
  raise notice 'PASS per-player question tracking';

  -- A timed-out home question settles home ground; no re-roll afterwards.
  update public.question_attempts set expires_at = now() - interval '1 minute'
  where id = (v_res2->'question'->>'attempt_id')::uuid;
  perform public.resolve_expired_sessions(v_season);
  select home_completed into v_done from public.group_members where group_id = v_g and user_id = u1;
  if not v_done then raise exception 'FAIL home_completed still false after timeout'; end if;
  raise notice 'PASS home timeout settles home ground';
  v_err := null;
  begin
    v_res2 := public.game_begin_action(v_season, 'WA', 'home', null);
    v_err := 'no-error';
  exception when others then v_err := sqlerrm; end;
  if v_err = 'no-error' then raise exception 'FAIL: home re-roll still possible after timeout';
  elsif v_err like '%already settled%' then raise notice 'PASS home re-roll blocked after timeout';
  else raise exception 'unexpected error: %', v_err; end if;

  -- Question recycling: once this player has seen every active WA question,
  -- a new WA session recycles the least recently served one instead of failing.
  insert into public.season_question_seen(season_id, question_id, served_to)
  select v_season, qq.id, u1 from public.questions qq
  where qq.territory_id = 'WA' and qq.active
  on conflict do nothing;
  v_res2 := public.game_begin_action(v_season, 'WA', 'fortify', null);
  if v_res2->'question'->>'attempt_id' is null then raise exception 'FAIL recycle did not serve a question'; end if;
  raise notice 'PASS exhausted state recycles questions';

  -- Fortify spends an action (it used to be free, allowing endless play).
  if (select actions_remaining from public.player_actions where season_id = v_season and user_id = u1) <> 2 then
    raise exception 'FAIL fortify did not spend an action';
  end if;
  raise notice 'PASS fortify costs an action';

  raise notice 'ALL ENGINE TESTS PASSED';
end $$;

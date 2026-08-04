-- Finding 10: `refresh_player_actions` opened with `perform public.run_daily_tick()`,
-- and `run_daily_tick` loops over *every active season in the database*.
-- `refresh_player_actions` is called by `group_snapshot` and by
-- `game_begin_action`, so every page load and every move ran a full cross-tenant
-- scoring pass -- amplified by the client's 5s and 20s polls, per open tab. It
-- also created a cross-group deadlock surface, since each caller updated other
-- groups' `player_actions` rows while holding locks on its own.
--
-- The cron route is now the only thing that advances a day, which is what
-- `vercel.json` always intended. Its auth hole (finding 2) is closed first, so
-- the one remaining day-advancer is the secure one.

create or replace function public.refresh_player_actions(p_season_id uuid, p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.player_actions;
  v_days integer;
  v_test boolean;
  v_turn uuid;
  v_timezone text;
  v_today date;
begin
  select g.test_mode, s.current_turn_user_id, coalesce(g.timezone, 'UTC')
    into v_test, v_turn, v_timezone
  from public.seasons s
  join public.groups g on g.id = s.group_id
  where s.id = p_season_id;

  if not found then raise exception 'Season not found'; end if;

  v_today := (now() at time zone v_timezone)::date;

  insert into public.player_actions(season_id, user_id, actions_remaining, last_refresh_on)
  values (p_season_id, p_user_id, case when v_test and v_turn is distinct from p_user_id then 0 else 3 end, v_today)
  on conflict do nothing;

  if v_test then
    update public.player_actions
      set actions_remaining = 0, updated_at = now()
    where season_id = p_season_id and user_id <> v_turn and actions_remaining <> 0;

    select * into v_row
    from public.player_actions
    where season_id = p_season_id and user_id = p_user_id
    for update;

    return case when v_turn = p_user_id then v_row.actions_remaining else 0 end;
  end if;

  select * into v_row
  from public.player_actions
  where season_id = p_season_id and user_id = p_user_id
  for update;

  v_days := greatest(0, v_today - v_row.last_refresh_on);
  if v_days > 0 then
    update public.player_actions
      set actions_remaining = least(5, actions_remaining + (v_days * 3)),
          last_refresh_on = v_today,
          updated_at = now()
    where season_id = p_season_id and user_id = p_user_id
    returning * into v_row;
  end if;

  return v_row.actions_remaining;
end;
$$;

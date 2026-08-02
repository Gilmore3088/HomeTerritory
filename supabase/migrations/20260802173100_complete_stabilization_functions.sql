create or replace function public.sync_question_attempt_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.answered_at is not null and old.answered_at is null then
    update public.questions q
    set attempt_count = stats.attempt_count,
        correct_count = stats.correct_count
    from (
      select question_id,
             count(*) filter (where answered_at is not null)::integer as attempt_count,
             count(*) filter (where is_correct = true)::integer as correct_count
      from public.question_attempts
      where question_id = new.question_id
      group by question_id
    ) stats
    where q.id = stats.question_id;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_question_attempt_stats_trigger on public.question_attempts;
create trigger sync_question_attempt_stats_trigger
after update of answered_at on public.question_attempts
for each row execute function public.sync_question_attempt_stats();

create or replace function public.run_test_bot_turns(p_season_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season public.seasons;
  v_group public.groups;
  v_bot record;
  v_attack record;
  v_target text;
  v_state_name text;
  v_success boolean;
  v_action text;
  v_count integer := 0;
  v_today date;
begin
  select * into v_season from public.seasons where id = p_season_id and status = 'active';
  if not found then return jsonb_build_object('actions', 0); end if;

  select * into v_group from public.groups where id = v_season.group_id;
  if not coalesce(v_group.test_mode, false) then return jsonb_build_object('actions', 0); end if;

  v_today := (now() at time zone coalesce(v_group.timezone, 'UTC'))::date;

  for v_bot in
    select gm.user_id, p.display_name
    from public.group_members gm
    join public.profiles p on p.id = gm.user_id
    where gm.group_id = v_season.group_id and coalesce(p.is_bot, false)
    order by gm.color_index
  loop
    if exists (
      select 1 from public.bot_action_log
      where season_id = p_season_id and bot_id = v_bot.user_id and acted_on = v_today
    ) then continue; end if;

    select a.* into v_attack
    from public.attacks a
    where a.season_id = p_season_id and a.defender_id = v_bot.user_id and a.status = 'contested'
    order by a.created_at
    limit 1
    for update;

    if found then
      v_success := random() < case when v_attack.tier = 3 then .45 else .65 end;
      v_action := 'defend';
      v_target := v_attack.territory_id;

      if v_success then
        update public.attacks set status = 'repelled', resolved_at = now() where id = v_attack.id;
        update public.season_territories
          set contested = false, hold_level = least(3, hold_level + 1), updated_at = now()
        where season_id = p_season_id and territory_id = v_target;
        select name into v_state_name from public.territories where id = v_target;
        insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
        values (p_season_id, v_bot.user_id, 'attack_repelled', v_target, format('%s automatically defended %s.', v_bot.display_name, v_state_name));
      else
        perform public.resolve_attack_win(v_attack.id, 'bot_defense');
      end if;
    else
      select neutral.territory_id into v_target
      from public.season_territories neutral
      where neutral.season_id = p_season_id
        and neutral.owner_id is null
        and neutral.contested = false
        and exists (
          select 1
          from public.season_territories owned
          join public.territories t on t.id = owned.territory_id
          where owned.season_id = p_season_id
            and owned.owner_id = v_bot.user_id
            and neutral.territory_id = any(t.adjacent)
        )
      order by random()
      limit 1;

      if v_target is not null then
        v_action := 'claim';
        v_success := random() < .78;
        if v_success then
          update public.season_territories
            set owner_id = v_bot.user_id, hold_level = 1, updated_at = now()
          where season_id = p_season_id and territory_id = v_target and owner_id is null;
          select name into v_state_name from public.territories where id = v_target;
          insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
          values (p_season_id, v_bot.user_id, 'state_claimed', v_target, format('%s claimed %s.', v_bot.display_name, v_state_name));
        end if;
      else
        select st.territory_id into v_target
        from public.season_territories st
        where st.season_id = p_season_id
          and st.owner_id = v_bot.user_id
          and st.contested = false
          and st.hold_level < 3
        order by st.hold_level, random()
        limit 1;

        if v_target is not null then
          v_action := 'fortify';
          v_success := random() < .82;
          if v_success then
            update public.season_territories
              set hold_level = least(3, hold_level + 1), updated_at = now()
            where season_id = p_season_id and territory_id = v_target;
            select name into v_state_name from public.territories where id = v_target;
            insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
            values (p_season_id, v_bot.user_id, 'state_fortified', v_target, format('%s fortified %s.', v_bot.display_name, v_state_name));
          end if;
        else
          v_action := 'wait';
          v_success := true;
        end if;
      end if;
    end if;

    insert into public.bot_action_log(season_id, bot_id, acted_on, action_type, territory_id, success)
    values (p_season_id, v_bot.user_id, v_today, coalesce(v_action, 'wait'), v_target, coalesce(v_success, false));
    v_count := v_count + 1;
    v_target := null;
  end loop;

  return jsonb_build_object('actions', v_count);
end;
$$;

create or replace function public.run_daily_tick()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season public.seasons;
  v_group public.groups;
  v_member record;
  v_state_points integer;
  v_level_points integer;
  v_region_points integer;
  v_coast_points integer;
  v_sport_points integer;
  v_total integer;
  v_scored integer := 0;
  v_today date;
  v_day integer;
begin
  for v_season in
    select * from public.seasons where status = 'active' for update skip locked
  loop
    select * into v_group from public.groups where id = v_season.group_id;
    v_today := (now() at time zone coalesce(v_group.timezone, 'UTC'))::date;
    v_day := greatest(1, least(v_group.season_length, v_today - v_season.started_at::date + 1));

    perform public.resolve_expired_sessions(v_season.id);
    perform public.resolve_expired_attacks(v_season.id);
    perform public.run_test_bot_turns(v_season.id);

    update public.seasons set current_day = v_day where id = v_season.id and current_day is distinct from v_day;

    if v_season.last_scored_on < v_today then
      if v_day > greatest(1, v_group.season_length - 3) then
        update public.season_territories
          set hold_level = greatest(1, hold_level - 1), updated_at = now()
        where season_id = v_season.id and hold_level > 1 and contested = false;

        insert into public.activity_events(season_id, event_type, message)
        values (v_season.id, 'twilight_decay', 'Twilight phase: every fortified state lost one garrison level.');
      end if;

      for v_member in
        select user_id from public.group_members where group_id = v_season.group_id
      loop
        select count(*) into v_state_points
        from public.season_territories
        where season_id = v_season.id and owner_id = v_member.user_id;

        select count(*) into v_level_points
        from public.season_territories
        where season_id = v_season.id and owner_id = v_member.user_id and hold_level = 3;

        select count(*) * 5 into v_region_points
        from (
          select t.region
          from public.territories t
          join public.season_territories st on st.territory_id = t.id and st.season_id = v_season.id
          where st.owner_id = v_member.user_id
          group by t.region
          having count(*) = (select count(*) from public.territories t2 where t2.region = t.region)
        ) full_regions;

        select case when
          exists (
            select 1 from public.season_territories
            where season_id = v_season.id and owner_id = v_member.user_id
              and territory_id = any(array['WA','OR','CA','AK','HI'])
          ) and exists (
            select 1 from public.season_territories
            where season_id = v_season.id and owner_id = v_member.user_id
              and territory_id = any(array['ME','NH','MA','RI','CT','NY','NJ','DE','MD','VA','NC','SC','GA','FL'])
          ) then 3 else 0 end into v_coast_points;

        select case when count(distinct q.sport) >= 3 then 2 else 0 end into v_sport_points
        from public.question_attempts qa
        join public.questions q on q.id = qa.question_id
        join public.game_sessions gs on gs.id = qa.session_id
        where gs.season_id = v_season.id
          and qa.user_id = v_member.user_id
          and qa.is_correct = true
          and (qa.answered_at at time zone coalesce(v_group.timezone, 'UTC'))::date = v_today;

        v_total := coalesce(v_state_points, 0)
          + coalesce(v_level_points, 0)
          + coalesce(v_region_points, 0)
          + coalesce(v_coast_points, 0)
          + coalesce(v_sport_points, 0);

        insert into public.daily_score_events(season_id, user_id, scored_on, points)
        values (v_season.id, v_member.user_id, v_today, v_total)
        on conflict do nothing;

        if found then
          update public.player_actions
            set cumulative_score = cumulative_score + v_total, updated_at = now()
          where season_id = v_season.id and user_id = v_member.user_id;
          v_scored := v_scored + 1;
        end if;
      end loop;

      update public.seasons set last_scored_on = v_today, current_day = v_day where id = v_season.id;
    end if;

    if v_season.ends_at <= now() then
      insert into public.season_recaps(season_id, recap)
      select v_season.id, jsonb_build_object(
        'winner', (
          select jsonb_build_object('user_id', pa.user_id, 'display_name', p.display_name, 'score', pa.cumulative_score)
          from public.player_actions pa
          join public.profiles p on p.id = pa.user_id
          where pa.season_id = v_season.id
          order by pa.cumulative_score desc
          limit 1
        ),
        'most_states', (
          select jsonb_build_object('user_id', st.owner_id, 'display_name', p.display_name, 'states', count(*))
          from public.season_territories st
          join public.profiles p on p.id = st.owner_id
          where st.season_id = v_season.id and st.owner_id is not null
          group by st.owner_id, p.display_name
          order by count(*) desc
          limit 1
        ),
        'ended_at', now()
      )
      on conflict (season_id) do nothing;

      update public.seasons set status = 'ended', current_day = v_group.season_length where id = v_season.id;
      update public.groups set status = 'ended' where id = v_season.group_id;
      insert into public.activity_events(season_id, event_type, message)
      values (v_season.id, 'season_ended', 'The season ended. Final scores are locked.');
    end if;
  end loop;

  return jsonb_build_object('players_scored', v_scored);
end;
$$;

revoke all on function public.run_test_bot_turns(uuid) from public;
grant execute on function public.run_test_bot_turns(uuid) to service_role;

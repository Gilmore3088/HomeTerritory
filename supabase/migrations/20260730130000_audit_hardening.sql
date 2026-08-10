-- Audit hardening (docs/repo-audit-2026-07-30.md, findings 10 and lows):
-- * Per-player question tracking: the season-wide (season_id, question_id) key
--   burned each question for the whole league, exhausting a state's 11-question
--   bank after a few contests. Seen-tracking is now per player.
-- * Profiles were readable by every authenticated user; now limited to yourself
--   and people who share a group with you.
-- * create_group_v2 accepted arbitrary sport strings; now validated.
-- * The legacy v1 create_group RPC (old card-grid UI, since removed) is closed.
-- * run_daily_tick skipped days the cron missed; missed days are now back-filled
--   at current holdings (an approximation, but better than losing the days).

-- Per-player seen tracking.
alter table public.season_question_seen drop constraint season_question_seen_pkey;
alter table public.season_question_seen add primary key (season_id, question_id, served_to);

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
    and not exists(
      select 1 from public.season_question_seen sqs
      where sqs.season_id = v_session.season_id and sqs.question_id = q.id and sqs.served_to = v_session.user_id
    )
  order by case when q.sport = any(v_sports) then 0 else 1 end, abs(q.tier - v_session.tier), random()
  limit 1;

  if not found then raise exception 'This state is temporarily out of unused questions'; end if;
  insert into public.season_question_seen(season_id, question_id, served_to) values (v_session.season_id, v_question.id, v_session.user_id);
  v_expires := now() + case when v_question.tier = 3 then interval '45 seconds' else interval '30 seconds' end;
  insert into public.question_attempts(session_id, question_id, user_id, expires_at)
  values (p_session_id, v_question.id, v_session.user_id, v_expires) returning id into v_attempt;
  update public.game_sessions set current_attempt_id = v_attempt where id = p_session_id;

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

-- Profiles: readable only by yourself and members of your groups.
create or replace function public.shares_group_with(p_other uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select p_other = auth.uid() or exists(
    select 1
    from public.group_members mine
    join public.group_members theirs on theirs.group_id = mine.group_id
    where mine.user_id = auth.uid() and theirs.user_id = p_other
  );
$$;
revoke execute on function public.shares_group_with(uuid) from public, anon;
grant execute on function public.shares_group_with(uuid) to authenticated;

drop policy "authenticated profiles are readable" on public.profiles;
create policy "own and shared-group profiles are readable" on public.profiles
for select to authenticated using (public.shares_group_with(id));

-- Validate sports input.
create or replace function public.create_group_v2(
  p_name text,
  p_sports text[],
  p_season_length integer default 14,
  p_opening_mode text default 'open',
  p_board_scope text default 'fifty',
  p_difficulty text default 'standard',
  p_test_mode boolean default false
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_group uuid;
  v_code text;
  v_sport text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if char_length(trim(p_name)) < 2 or char_length(trim(p_name)) > 60 then raise exception 'Group name must be 2-60 characters'; end if;
  if cardinality(p_sports) < 1 or cardinality(p_sports) > 10 then raise exception 'Select between one and ten sports'; end if;
  foreach v_sport in array p_sports loop
    if v_sport is null or char_length(trim(v_sport)) < 1 or char_length(trim(v_sport)) > 24 then
      raise exception 'Invalid sport name';
    end if;
  end loop;
  if p_season_length not in (7, 10, 14, 30, 60) then raise exception 'Invalid season length'; end if;
  if p_opening_mode not in ('open','dealt') then raise exception 'Invalid opening mode'; end if;
  if p_board_scope not in ('fifty','lower48') then raise exception 'Invalid board scope'; end if;
  if p_difficulty not in ('casual','standard','hardcore') then raise exception 'Invalid difficulty'; end if;

  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists(select 1 from public.groups where invite_code = v_code);
  end loop;

  insert into public.groups(name, commissioner_id, invite_code, sports, season_length, opening_mode, board_scope, difficulty, test_mode)
  values (trim(p_name), v_user, v_code, p_sports, p_season_length, p_opening_mode, p_board_scope, p_difficulty, p_test_mode)
  returning id into v_group;

  insert into public.group_members(group_id, user_id, color_index) values (v_group, v_user, 0);
  return v_group;
end;
$$;

-- The v1 create_group RPC backed the removed card-grid UI; close it.
revoke execute on function public.create_group(text, text[], integer) from public, anon, authenticated;

-- Back-fill days the daily cron missed instead of silently skipping them.
-- Missed days are scored at current holdings - an approximation, since the map
-- may have changed since, but fairer than dropping the days entirely.
create or replace function public.run_daily_tick()
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_season public.seasons;
  v_member record;
  v_score_date date;
  v_state_points integer;
  v_level_points integer;
  v_region_points integer;
  v_total integer;
  v_scored integer := 0;
begin
  for v_season in select * from public.seasons where status = 'active' for update skip locked loop
    perform public.resolve_expired_sessions(v_season.id);
    perform public.resolve_expired_attacks(v_season.id);
    while v_season.last_scored_on < current_date loop
      v_score_date := v_season.last_scored_on + 1;
      for v_member in select user_id from public.group_members where group_id = v_season.group_id loop
        select count(*) into v_state_points from public.season_territories where season_id = v_season.id and owner_id = v_member.user_id;
        select count(*) into v_level_points from public.season_territories where season_id = v_season.id and owner_id = v_member.user_id and hold_level = 3;
        select count(*) * 5 into v_region_points from (
          select t.region
          from public.territories t join public.season_territories st on st.territory_id = t.id and st.season_id = v_season.id
          where st.owner_id = v_member.user_id
          group by t.region
          having count(*) = (select count(*) from public.territories t2 where t2.region = t.region)
        ) full_regions;
        v_total := coalesce(v_state_points, 0) + coalesce(v_level_points, 0) + coalesce(v_region_points, 0);
        insert into public.daily_score_events(season_id, user_id, scored_on, points)
        values (v_season.id, v_member.user_id, v_score_date, v_total)
        on conflict do nothing;
        if found then
          update public.player_actions set cumulative_score = cumulative_score + v_total, updated_at = now() where season_id = v_season.id and user_id = v_member.user_id;
          v_scored := v_scored + 1;
        end if;
      end loop;
      update public.seasons set last_scored_on = v_score_date where id = v_season.id;
      v_season.last_scored_on := v_score_date;
    end loop;
    if v_season.ends_at <= now() then
      update public.seasons set status = 'ended' where id = v_season.id;
      update public.groups set status = 'ended' where id = v_season.group_id;
      insert into public.activity_events(season_id, event_type, message) values (v_season.id, 'season_ended', 'The season ended. Final scores are locked.');
    end if;
  end loop;
  return jsonb_build_object('players_scored', v_scored);
end;
$$;

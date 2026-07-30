-- HomeTerritory production MVP schema.
-- Run with `supabase db push` or paste into a new Supabase project's SQL editor.

create extension if not exists pgcrypto;
create extension if not exists fuzzystrmatch;
create extension if not exists unaccent;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Player',
  created_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 60),
  commissioner_id uuid not null references public.profiles(id),
  invite_code text not null unique check (char_length(invite_code) = 8),
  sports text[] not null check (cardinality(sports) > 0),
  season_length integer not null default 30 check (season_length in (14, 30, 60)),
  status text not null default 'lobby' check (status in ('lobby', 'active', 'ended')),
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  color_index integer not null check (color_index between 0 and 7),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id),
  unique (group_id, color_index)
);

create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'ended')),
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  last_scored_on date not null default current_date,
  created_at timestamptz not null default now()
);
create unique index one_active_season_per_group on public.seasons(group_id) where status = 'active';

create table public.territories (
  id text primary key check (char_length(id) = 2),
  name text not null unique,
  region text not null,
  adjacent text[] not null default '{}'
);

create table public.season_territories (
  season_id uuid not null references public.seasons(id) on delete cascade,
  territory_id text not null references public.territories(id),
  owner_id uuid references public.profiles(id),
  hold_level integer not null default 1 check (hold_level between 1 and 3),
  contested boolean not null default false,
  last_contested_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (season_id, territory_id)
);
create index season_territories_owner_idx on public.season_territories(season_id, owner_id);

create table public.player_actions (
  season_id uuid not null references public.seasons(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  actions_remaining integer not null default 3 check (actions_remaining between 0 and 5),
  last_refresh_on date not null default current_date,
  cumulative_score integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (season_id, user_id)
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  territory_id text not null references public.territories(id),
  sport text not null,
  link_type text not null,
  tier integer not null check (tier between 1 and 3),
  format text not null check (format in ('multiple_choice', 'free_fill')),
  question_text text not null,
  options jsonb not null default '[]'::jsonb,
  correct_answer text not null,
  aliases text[] not null default '{}',
  rejects text[] not null default '{}',
  source_url text,
  validation_status text not null default 'starter_seed',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index questions_picker_idx on public.questions(territory_id, tier, active);

create table public.season_question_seen (
  season_id uuid not null references public.seasons(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  served_to uuid not null references public.profiles(id),
  served_at timestamptz not null default now(),
  primary key (season_id, question_id)
);

create table public.attacks (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  territory_id text not null references public.territories(id),
  attacker_id uuid not null references public.profiles(id),
  defender_id uuid not null references public.profiles(id),
  tier integer not null check (tier in (2, 3)),
  status text not null default 'contested' check (status in ('contested', 'repelled', 'won', 'void')),
  defense_deadline timestamptz not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index one_contested_attack_per_territory on public.attacks(season_id, territory_id) where status = 'contested';

create table public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  territory_id text not null references public.territories(id),
  user_id uuid not null references public.profiles(id),
  action_type text not null check (action_type in ('claim', 'attack', 'fortify', 'defend')),
  attack_id uuid references public.attacks(id),
  required_correct integer not null check (required_correct between 1 and 3),
  correct_count integer not null default 0,
  tier integer not null check (tier between 1 and 3),
  status text not null default 'active' check (status in ('active', 'completed', 'failed', 'void')),
  current_attempt_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes')
);
create index game_sessions_user_idx on public.game_sessions(user_id, status);

create table public.question_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  question_id uuid not null references public.questions(id),
  user_id uuid not null references public.profiles(id),
  answer_text text,
  is_correct boolean,
  served_at timestamptz not null default now(),
  answered_at timestamptz,
  expires_at timestamptz not null
);
alter table public.game_sessions add constraint game_sessions_current_attempt_fk foreign key (current_attempt_id) references public.question_attempts(id);

create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  actor_id uuid references public.profiles(id),
  event_type text not null,
  territory_id text references public.territories(id),
  message text not null,
  created_at timestamptz not null default now()
);
create index activity_events_season_idx on public.activity_events(season_id, created_at desc);

create table public.cooldowns (
  season_id uuid not null references public.seasons(id) on delete cascade,
  territory_id text not null references public.territories(id),
  user_id uuid not null references public.profiles(id),
  action_type text not null,
  expires_at timestamptz not null,
  primary key (season_id, territory_id, user_id, action_type)
);

create table public.fortify_log (
  season_id uuid not null references public.seasons(id) on delete cascade,
  territory_id text not null references public.territories(id),
  user_id uuid not null references public.profiles(id),
  played_on date not null default current_date,
  primary key (season_id, territory_id, user_id, played_on)
);

create table public.question_reports (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id),
  attempt_id uuid not null references public.question_attempts(id),
  reported_by uuid not null references public.profiles(id),
  reason text not null,
  created_at timestamptz not null default now()
);

create table public.daily_score_events (
  season_id uuid not null references public.seasons(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  scored_on date not null,
  points integer not null,
  created_at timestamptz not null default now(),
  primary key (season_id, user_id, scored_on)
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(new.email, '@', 1), 'Player'))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_group_member(p_group_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(select 1 from public.group_members where group_id = p_group_id and user_id = p_user_id);
$$;

create or replace function public.normalize_answer(p_value text)
returns text
language sql
stable
as $$
  select trim(regexp_replace(lower(unaccent(coalesce(p_value, ''))), '[^a-z0-9]+', ' ', 'g'));
$$;

create or replace function public.answer_matches(p_question public.questions, p_answer text)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  v_answer text := public.normalize_answer(p_answer);
  v_candidate text;
begin
  foreach v_candidate in array p_question.rejects loop
    if v_answer = public.normalize_answer(v_candidate) then return false; end if;
  end loop;

  if v_answer = public.normalize_answer(p_question.correct_answer) then return true; end if;
  foreach v_candidate in array p_question.aliases loop
    if v_answer = public.normalize_answer(v_candidate) then return true; end if;
  end loop;

  if char_length(v_answer) > 6 and levenshtein_less_equal(v_answer, public.normalize_answer(p_question.correct_answer), 2) <= 2 then
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.create_group(p_name text, p_sports text[], p_season_length integer default 30)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_group uuid;
  v_code text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if char_length(trim(p_name)) < 2 then raise exception 'Group name is too short'; end if;
  if cardinality(p_sports) < 1 then raise exception 'Select at least one sport'; end if;
  if p_season_length not in (14, 30, 60) then raise exception 'Invalid season length'; end if;

  loop
    v_code := upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8));
    exit when not exists(select 1 from public.groups where invite_code = v_code);
  end loop;

  insert into public.groups(name, commissioner_id, invite_code, sports, season_length)
  values (trim(p_name), v_user, v_code, p_sports, p_season_length)
  returning id into v_group;

  insert into public.group_members(group_id, user_id, color_index) values (v_group, v_user, 0);
  return v_group;
end;
$$;

create or replace function public.join_group(p_invite_code text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_group public.groups;
  v_count integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_group from public.groups where invite_code = upper(trim(p_invite_code)) for update;
  if not found then raise exception 'Invite code not found'; end if;
  if v_group.status <> 'lobby' then raise exception 'This group has already started'; end if;
  if exists(select 1 from public.group_members where group_id = v_group.id and user_id = v_user) then return v_group.id; end if;
  select count(*) into v_count from public.group_members where group_id = v_group.id;
  if v_count >= 8 then raise exception 'This group is full'; end if;
  insert into public.group_members(group_id, user_id, color_index) values (v_group.id, v_user, v_count);
  return v_group.id;
end;
$$;

create or replace function public.get_my_groups()
returns jsonb
language sql
stable
security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', g.id,
    'name', g.name,
    'status', g.status,
    'invite_code', g.invite_code,
    'sports', g.sports,
    'member_count', (select count(*) from public.group_members gm2 where gm2.group_id = g.id),
    'is_commissioner', g.commissioner_id = auth.uid()
  ) order by g.created_at desc), '[]'::jsonb)
  from public.groups g
  join public.group_members gm on gm.group_id = g.id
  where gm.user_id = auth.uid();
$$;

create or replace function public.start_season(p_group_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_group public.groups;
  v_season uuid;
  v_count integer;
begin
  select * into v_group from public.groups where id = p_group_id for update;
  if not found then raise exception 'Group not found'; end if;
  if v_group.commissioner_id <> auth.uid() then raise exception 'Only the commissioner can start the season'; end if;
  if v_group.status <> 'lobby' then raise exception 'Season already started'; end if;
  select count(*) into v_count from public.group_members where group_id = p_group_id;
  if v_count < 3 then raise exception 'At least three players are required'; end if;

  insert into public.seasons(group_id, ends_at)
  values (p_group_id, now() + make_interval(days => v_group.season_length)) returning id into v_season;

  insert into public.season_territories(season_id, territory_id)
  select v_season, id from public.territories;

  insert into public.player_actions(season_id, user_id)
  select v_season, user_id from public.group_members where group_id = p_group_id;

  update public.groups set status = 'active' where id = p_group_id;
  insert into public.activity_events(season_id, actor_id, event_type, message)
  values (v_season, auth.uid(), 'season_started', 'The season started. The map is open.');
  return v_season;
end;
$$;

create or replace function public.refresh_player_actions(p_season_id uuid, p_user_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_row public.player_actions;
  v_days integer;
begin
  insert into public.player_actions(season_id, user_id) values (p_season_id, p_user_id) on conflict do nothing;
  select * into v_row from public.player_actions where season_id = p_season_id and user_id = p_user_id for update;
  v_days := greatest(0, current_date - v_row.last_refresh_on);
  if v_days > 0 then
    update public.player_actions
      set actions_remaining = least(5, actions_remaining + (v_days * 3)), last_refresh_on = current_date, updated_at = now()
      where season_id = p_season_id and user_id = p_user_id
      returning actions_remaining into v_row.actions_remaining;
  end if;
  return v_row.actions_remaining;
end;
$$;

create or replace function public.resolve_attack_win(p_attack_id uuid, p_reason text default 'timeout')
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_attack public.attacks;
  v_state_name text;
  v_attacker_name text;
begin
  select * into v_attack from public.attacks where id = p_attack_id for update;
  if not found or v_attack.status <> 'contested' then return; end if;
  update public.attacks set status = 'won', resolved_at = now() where id = p_attack_id;
  update public.season_territories
    set owner_id = v_attack.attacker_id, hold_level = 1, contested = false, updated_at = now()
    where season_id = v_attack.season_id and territory_id = v_attack.territory_id;
  select name into v_state_name from public.territories where id = v_attack.territory_id;
  select display_name into v_attacker_name from public.profiles where id = v_attack.attacker_id;
  insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
  values (v_attack.season_id, v_attack.attacker_id, 'state_stolen', v_attack.territory_id,
    format('%s took %s%s', v_attacker_name, v_state_name, case when p_reason = 'timeout' then ' after the defense expired.' else '.' end));
end;
$$;

create or replace function public.resolve_expired_attacks(p_season_id uuid default null)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_attack record;
  v_count integer := 0;
begin
  for v_attack in
    select id from public.attacks
    where status = 'contested' and defense_deadline <= now() and (p_season_id is null or season_id = p_season_id)
    for update skip locked
  loop
    perform public.resolve_attack_win(v_attack.id, 'timeout');
    v_count := v_count + 1;
  end loop;
  return v_count;
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

  select coalesce(jsonb_agg(value order by random()), '[]'::jsonb) into v_options
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
  v_user uuid := auth.uid();
  v_season public.seasons;
  v_state public.season_territories;
  v_attack public.attacks;
  v_session uuid;
  v_required integer := 1;
  v_tier integer := 1;
  v_actions integer;
  v_leader integer;
  v_player_score integer;
  v_owner_count integer;
  v_is_adjacent boolean;
  v_question jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_season from public.seasons where id = p_season_id and status = 'active';
  if not found then raise exception 'Active season not found'; end if;
  if not public.is_group_member(v_season.group_id, v_user) then raise exception 'You are not in this group'; end if;
  perform public.resolve_expired_sessions(p_season_id);
  perform public.resolve_expired_attacks(p_season_id);
  select * into v_state from public.season_territories where season_id = p_season_id and territory_id = p_territory_id for update;
  if not found then raise exception 'Territory not found'; end if;

  select count(*) into v_owner_count from public.season_territories where season_id = p_season_id and owner_id = v_user;
  select exists(
    select 1 from public.season_territories st
    join public.territories t on t.id = st.territory_id
    where st.season_id = p_season_id and st.owner_id = v_user and p_territory_id = any(t.adjacent)
  ) into v_is_adjacent;

  if p_action_type in ('claim', 'attack') then
    v_actions := public.refresh_player_actions(p_season_id, v_user);
    if v_actions < 1 then raise exception 'No attack actions remaining'; end if;
  end if;

  if p_action_type = 'claim' then
    if v_state.owner_id is not null or v_state.contested then raise exception 'This state is not neutral'; end if;
    if v_owner_count > 0 and not v_is_adjacent then raise exception 'You must claim an adjacent state'; end if;
    if exists(select 1 from public.cooldowns where season_id = p_season_id and territory_id = p_territory_id and user_id = v_user and action_type = 'claim' and expires_at > now()) then raise exception 'This state is cooling down'; end if;
    update public.player_actions set actions_remaining = actions_remaining - 1, updated_at = now() where season_id = p_season_id and user_id = v_user;
    v_required := 1; v_tier := 1;

  elsif p_action_type = 'attack' then
    if v_state.owner_id is null or v_state.owner_id = v_user then raise exception 'Choose another player''s state'; end if;
    if v_state.contested or exists(select 1 from public.attacks where season_id = p_season_id and territory_id = p_territory_id and status = 'contested') then raise exception 'This state is already contested'; end if;
    if v_owner_count > 0 and not v_is_adjacent then raise exception 'You must attack an adjacent state'; end if;
    v_required := case when v_state.hold_level = 1 then 2 else 3 end;
    v_tier := case when v_state.hold_level = 3 then 3 else 2 end;
    select coalesce(max(cumulative_score), 0) into v_leader from public.player_actions where season_id = p_season_id;
    select cumulative_score into v_player_score from public.player_actions where season_id = p_season_id and user_id = v_user;
    if v_leader > 0 and v_player_score < v_leader * 0.60 then v_required := greatest(1, v_required - 1); end if;
    update public.player_actions set actions_remaining = actions_remaining - 1, updated_at = now() where season_id = p_season_id and user_id = v_user;

  elsif p_action_type = 'fortify' then
    if v_state.owner_id <> v_user then raise exception 'You do not own this state'; end if;
    if v_state.contested then raise exception 'A contested state cannot be fortified'; end if;
    if v_state.hold_level >= 3 then raise exception 'This state is already fully fortified'; end if;
    insert into public.fortify_log(season_id, territory_id, user_id) values (p_season_id, p_territory_id, v_user)
    on conflict do nothing;
    if not found then raise exception 'You already fortified this state today'; end if;
    v_required := 1; v_tier := 2;

  elsif p_action_type = 'defend' then
    select * into v_attack from public.attacks where id = p_attack_id and season_id = p_season_id and territory_id = p_territory_id for update;
    if not found or v_attack.status <> 'contested' then raise exception 'Active attack not found'; end if;
    if v_attack.defender_id <> v_user then raise exception 'Only the owner can defend'; end if;
    if v_attack.defense_deadline <= now() then
      perform public.resolve_attack_win(v_attack.id, 'timeout');
      raise exception 'The defense window expired';
    end if;
    if exists(select 1 from public.game_sessions where attack_id = v_attack.id and action_type = 'defend' and status in ('active', 'completed', 'failed')) then raise exception 'This defense has already been played'; end if;
    v_required := 1; v_tier := v_attack.tier;
  else
    raise exception 'Invalid action type';
  end if;

  insert into public.game_sessions(season_id, territory_id, user_id, action_type, attack_id, required_correct, tier)
  values (p_season_id, p_territory_id, v_user, p_action_type, p_attack_id, v_required, v_tier)
  returning id into v_session;
  v_question := public.pick_next_question(v_session);

  return jsonb_build_object('session_id', v_session, 'question', v_question, 'required_correct', v_required, 'correct_count', 0);
end;
$$;

create or replace function public.game_submit_answer(p_session_id uuid, p_answer text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_session public.game_sessions;
  v_attempt public.question_attempts;
  v_question public.questions;
  v_correct boolean;
  v_count integer;
  v_next jsonb;
  v_state_name text;
  v_player_name text;
  v_attack_id uuid;
  v_defender uuid;
begin
  select * into v_session from public.game_sessions where id = p_session_id for update;
  if not found or v_session.user_id <> v_user then raise exception 'Game session not found'; end if;
  if v_session.status <> 'active' then raise exception 'This trivia session is already closed'; end if;
  select * into v_attempt from public.question_attempts where id = v_session.current_attempt_id for update;
  if not found or v_attempt.answered_at is not null then raise exception 'Question attempt is already closed'; end if;
  select * into v_question from public.questions where id = v_attempt.question_id;

  v_correct := now() <= v_attempt.expires_at and public.answer_matches(v_question, p_answer);
  update public.question_attempts set answer_text = p_answer, is_correct = v_correct, answered_at = now() where id = v_attempt.id;
  select name into v_state_name from public.territories where id = v_session.territory_id;
  select display_name into v_player_name from public.profiles where id = v_user;

  if not v_correct then
    update public.game_sessions set status = 'failed' where id = p_session_id;
    if v_session.action_type = 'claim' then
      insert into public.cooldowns(season_id, territory_id, user_id, action_type, expires_at)
      values (v_session.season_id, v_session.territory_id, v_user, 'claim', now() + interval '6 hours')
      on conflict (season_id, territory_id, user_id, action_type) do update set expires_at = excluded.expires_at;
    elsif v_session.action_type = 'defend' then
      perform public.resolve_attack_win(v_session.attack_id, 'incorrect');
    end if;
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_session.season_id, v_user, 'answer_missed', v_session.territory_id, format('%s missed a question in %s.', v_player_name, v_state_name));
    return jsonb_build_object('status', 'failed', 'message', case when v_session.action_type = 'defend' then 'Incorrect. The attacker takes the state.' else 'Incorrect. The map does not change.' end);
  end if;

  v_count := v_session.correct_count + 1;
  if v_count < v_session.required_correct then
    update public.game_sessions set correct_count = v_count where id = p_session_id;
    v_next := public.pick_next_question(p_session_id);
    return jsonb_build_object('status', 'active', 'message', 'Correct. Keep the streak alive.', 'question', v_next, 'correct_count', v_count, 'required_correct', v_session.required_correct);
  end if;

  update public.game_sessions set correct_count = v_count, status = 'completed' where id = p_session_id;

  if v_session.action_type = 'claim' then
    update public.season_territories set owner_id = v_user, hold_level = 1, updated_at = now() where season_id = v_session.season_id and territory_id = v_session.territory_id;
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_session.season_id, v_user, 'state_claimed', v_session.territory_id, format('%s claimed %s.', v_player_name, v_state_name));
    return jsonb_build_object('status', 'completed', 'message', format('Correct. %s is yours.', v_state_name));

  elsif v_session.action_type = 'attack' then
    select owner_id into v_defender from public.season_territories where season_id = v_session.season_id and territory_id = v_session.territory_id for update;
    insert into public.attacks(season_id, territory_id, attacker_id, defender_id, tier, defense_deadline)
    values (v_session.season_id, v_session.territory_id, v_user, v_defender, v_session.tier, now() + interval '24 hours') returning id into v_attack_id;
    update public.season_territories set contested = true, last_contested_at = now(), updated_at = now() where season_id = v_session.season_id and territory_id = v_session.territory_id;
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_session.season_id, v_user, 'attack_started', v_session.territory_id, format('%s put %s under attack.', v_player_name, v_state_name));
    return jsonb_build_object('status', 'contested', 'message', format('Streak complete. %s has 24 hours to defend.', v_state_name), 'attack_id', v_attack_id);

  elsif v_session.action_type = 'fortify' then
    update public.season_territories set hold_level = least(3, hold_level + 1), updated_at = now() where season_id = v_session.season_id and territory_id = v_session.territory_id;
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_session.season_id, v_user, 'state_fortified', v_session.territory_id, format('%s fortified %s.', v_player_name, v_state_name));
    return jsonb_build_object('status', 'completed', 'message', format('Correct. %s is stronger.', v_state_name));

  elsif v_session.action_type = 'defend' then
    update public.attacks set status = 'repelled', resolved_at = now() where id = v_session.attack_id and status = 'contested';
    update public.season_territories set contested = false, hold_level = least(3, hold_level + 1), updated_at = now() where season_id = v_session.season_id and territory_id = v_session.territory_id;
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_session.season_id, v_user, 'attack_repelled', v_session.territory_id, format('%s defended %s.', v_player_name, v_state_name));
    return jsonb_build_object('status', 'completed', 'message', format('Correct. You defended %s and raised its hold.', v_state_name));
  end if;

  raise exception 'Unsupported game state';
end;
$$;

create or replace function public.report_question(p_attempt_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_attempt public.question_attempts;
  v_session public.game_sessions;
begin
  select * into v_attempt from public.question_attempts where id = p_attempt_id for update;
  if not found or v_attempt.user_id <> auth.uid() then raise exception 'Attempt not found'; end if;
  select * into v_session from public.game_sessions where id = v_attempt.session_id for update;
  if v_session.status <> 'active' then raise exception 'This session is already resolved'; end if;

  update public.questions set active = false where id = v_attempt.question_id;
  insert into public.question_reports(question_id, attempt_id, reported_by, reason)
  values (v_attempt.question_id, v_attempt.id, auth.uid(), left(coalesce(p_reason, 'Question reported'), 500));
  update public.question_attempts set answered_at = now(), answer_text = '[reported]' where id = v_attempt.id;
  update public.game_sessions set status = 'void' where id = v_session.id;

  if v_session.action_type in ('claim', 'attack') then
    update public.player_actions set actions_remaining = least(5, actions_remaining + 1), updated_at = now()
    where season_id = v_session.season_id and user_id = auth.uid();
  elsif v_session.action_type = 'fortify' then
    delete from public.fortify_log where season_id = v_session.season_id and territory_id = v_session.territory_id and user_id = auth.uid() and played_on = current_date;
  end if;

  return jsonb_build_object('status', 'void', 'message', 'Question quarantined and action refunded.');
end;
$$;

create or replace function public.group_snapshot(p_group_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_group public.groups;
  v_season public.seasons;
  v_members jsonb;
  v_territories jsonb := '[]'::jsonb;
  v_attacks jsonb := '[]'::jsonb;
  v_scores jsonb := '[]'::jsonb;
  v_activity jsonb := '[]'::jsonb;
  v_actions integer := 0;
begin
  if not public.is_group_member(p_group_id, auth.uid()) then raise exception 'Group access denied'; end if;
  select * into v_group from public.groups where id = p_group_id;
  select * into v_season from public.seasons where group_id = p_group_id order by created_at desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object('user_id', gm.user_id, 'display_name', p.display_name, 'color_index', gm.color_index) order by gm.color_index), '[]'::jsonb)
  into v_members from public.group_members gm join public.profiles p on p.id = gm.user_id where gm.group_id = p_group_id;

  if v_season.id is not null then
    perform public.resolve_expired_sessions(v_season.id);
    perform public.resolve_expired_attacks(v_season.id);
    v_actions := public.refresh_player_actions(v_season.id, auth.uid());

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'region', t.region, 'adjacent', t.adjacent,
      'owner_id', st.owner_id, 'hold_level', st.hold_level, 'contested', st.contested
    ) order by t.name), '[]'::jsonb)
    into v_territories from public.territories t join public.season_territories st on st.territory_id = t.id where st.season_id = v_season.id;

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'territory_id', a.territory_id, 'attacker_id', a.attacker_id, 'defender_id', a.defender_id,
      'status', a.status, 'defense_deadline', a.defense_deadline, 'tier', a.tier
    ) order by a.created_at desc), '[]'::jsonb)
    into v_attacks from public.attacks a where a.season_id = v_season.id and a.status = 'contested';

    select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', gm.user_id, 'display_name', p.display_name, 'color_index', gm.color_index,
      'cumulative_score', coalesce(pa.cumulative_score, 0),
      'state_count', (select count(*) from public.season_territories st where st.season_id = v_season.id and st.owner_id = gm.user_id)
    ) order by coalesce(pa.cumulative_score, 0) desc, p.display_name), '[]'::jsonb)
    into v_scores from public.group_members gm join public.profiles p on p.id = gm.user_id left join public.player_actions pa on pa.season_id = v_season.id and pa.user_id = gm.user_id where gm.group_id = p_group_id;

    select coalesce(jsonb_agg(event order by event.created_at desc), '[]'::jsonb)
    into v_activity from (
      select id, message, created_at, territory_id from public.activity_events where season_id = v_season.id order by created_at desc limit 30
    ) event;
  end if;

  return jsonb_build_object(
    'current_user_id', auth.uid(),
    'group', jsonb_build_object('id', v_group.id, 'name', v_group.name, 'commissioner_id', v_group.commissioner_id, 'invite_code', v_group.invite_code, 'sports', v_group.sports, 'status', v_group.status),
    'season', case when v_season.id is null then null else jsonb_build_object('id', v_season.id, 'status', v_season.status, 'started_at', v_season.started_at, 'ends_at', v_season.ends_at) end,
    'members', v_members,
    'territories', v_territories,
    'attacks', v_attacks,
    'scores', v_scores,
    'activity', v_activity,
    'actions_remaining', v_actions
  );
end;
$$;

create or replace function public.run_daily_tick()
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_season public.seasons;
  v_member record;
  v_state_points integer;
  v_level_points integer;
  v_region_points integer;
  v_total integer;
  v_scored integer := 0;
begin
  for v_season in select * from public.seasons where status = 'active' for update skip locked loop
    perform public.resolve_expired_sessions(v_season.id);
    perform public.resolve_expired_attacks(v_season.id);
    if v_season.last_scored_on < current_date then
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
        values (v_season.id, v_member.user_id, current_date, v_total)
        on conflict do nothing;
        if found then
          update public.player_actions set cumulative_score = cumulative_score + v_total, updated_at = now() where season_id = v_season.id and user_id = v_member.user_id;
          v_scored := v_scored + 1;
        end if;
      end loop;
      update public.seasons set last_scored_on = current_date where id = v_season.id;
    end if;
    if v_season.ends_at <= now() then
      update public.seasons set status = 'ended' where id = v_season.id;
      update public.groups set status = 'ended' where id = v_season.group_id;
      insert into public.activity_events(season_id, event_type, message) values (v_season.id, 'season_ended', 'The season ended. Final scores are locked.');
    end if;
  end loop;
  return jsonb_build_object('players_scored', v_scored);
end;
$$;

-- RLS: members can read their games; all mutations run through security-definer RPCs.
alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.seasons enable row level security;
alter table public.territories enable row level security;
alter table public.season_territories enable row level security;
alter table public.player_actions enable row level security;
alter table public.questions enable row level security;
alter table public.season_question_seen enable row level security;
alter table public.attacks enable row level security;
alter table public.game_sessions enable row level security;
alter table public.question_attempts enable row level security;
alter table public.activity_events enable row level security;
alter table public.cooldowns enable row level security;
alter table public.fortify_log enable row level security;
alter table public.question_reports enable row level security;
alter table public.daily_score_events enable row level security;

create policy "authenticated profiles are readable" on public.profiles for select to authenticated using (true);
create policy "members read groups" on public.groups for select to authenticated using (public.is_group_member(id));
create policy "members read memberships" on public.group_members for select to authenticated using (public.is_group_member(group_id));
create policy "members read seasons" on public.seasons for select to authenticated using (public.is_group_member(group_id));
create policy "territories are readable" on public.territories for select to authenticated using (true);
create policy "members read map" on public.season_territories for select to authenticated using (exists(select 1 from public.seasons s where s.id = season_id and public.is_group_member(s.group_id)));
create policy "members read scores" on public.player_actions for select to authenticated using (exists(select 1 from public.seasons s where s.id = season_id and public.is_group_member(s.group_id)));
create policy "members read attacks" on public.attacks for select to authenticated using (exists(select 1 from public.seasons s where s.id = season_id and public.is_group_member(s.group_id)));
create policy "members read activity" on public.activity_events for select to authenticated using (exists(select 1 from public.seasons s where s.id = season_id and public.is_group_member(s.group_id)));
create policy "members read daily scores" on public.daily_score_events for select to authenticated using (exists(select 1 from public.seasons s where s.id = season_id and public.is_group_member(s.group_id)));

revoke all on public.questions from anon, authenticated;
revoke all on public.game_sessions from anon, authenticated;
revoke all on public.question_attempts from anon, authenticated;
revoke all on public.season_question_seen from anon, authenticated;
revoke all on public.cooldowns from anon, authenticated;
revoke all on public.fortify_log from anon, authenticated;
revoke all on public.question_reports from anon, authenticated;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_group_member(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.normalize_answer(text) from public, anon, authenticated;
revoke execute on function public.answer_matches(public.questions, text) from public, anon, authenticated;
revoke execute on function public.refresh_player_actions(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.resolve_attack_win(uuid, text) from public, anon, authenticated;
revoke execute on function public.resolve_expired_attacks(uuid) from public, anon, authenticated;
revoke execute on function public.resolve_expired_sessions(uuid) from public, anon, authenticated;
revoke execute on function public.pick_next_question(uuid) from public, anon, authenticated;
revoke execute on function public.run_daily_tick() from public, anon, authenticated;

-- Security-definer RPCs are the only mutation surface exposed to signed-in players.
-- PostgreSQL grants function execution to PUBLIC by default, so remove that implicit grant.
revoke execute on function public.create_group(text, text[], integer) from public, anon;
revoke execute on function public.join_group(text) from public, anon;
revoke execute on function public.get_my_groups() from public, anon;
revoke execute on function public.start_season(uuid) from public, anon;
revoke execute on function public.group_snapshot(uuid) from public, anon;
revoke execute on function public.game_begin_action(uuid, text, text, uuid) from public, anon;
revoke execute on function public.game_submit_answer(uuid, text) from public, anon;
revoke execute on function public.report_question(uuid, text) from public, anon;

grant select on public.profiles, public.groups, public.group_members, public.seasons, public.territories, public.season_territories, public.player_actions, public.attacks, public.activity_events, public.daily_score_events to authenticated;
grant execute on function public.is_group_member(uuid, uuid) to authenticated;
grant execute on function public.run_daily_tick() to service_role;
grant execute on function public.create_group(text, text[], integer) to authenticated;
grant execute on function public.join_group(text) to authenticated;
grant execute on function public.get_my_groups() to authenticated;
grant execute on function public.start_season(uuid) to authenticated;
grant execute on function public.group_snapshot(uuid) to authenticated;
grant execute on function public.game_begin_action(uuid, text, text, uuid) to authenticated;
grant execute on function public.game_submit_answer(uuid, text) to authenticated;
grant execute on function public.report_question(uuid, text) to authenticated;

-- Allow Supabase Realtime to publish the shared map and feed.
alter publication supabase_realtime add table public.season_territories;
alter publication supabase_realtime add table public.attacks;
alter publication supabase_realtime add table public.activity_events;
alter publication supabase_realtime add table public.player_actions;

insert into public.territories(id, name, region, adjacent) values
('AL','Alabama','Southeast',array['MS','TN','GA','FL']),
('AK','Alaska','Pacific',array['WA','OR','CA','HI']),
('AZ','Arizona','Southwest',array['CA','NV','UT','NM']),
('AR','Arkansas','South',array['TX','OK','MO','TN','MS','LA']),
('CA','California','Pacific',array['OR','NV','AZ','AK','HI']),
('CO','Colorado','Mountain',array['WY','NE','KS','OK','NM','UT']),
('CT','Connecticut','Northeast',array['NY','MA','RI']),
('DE','Delaware','Northeast',array['MD','PA','NJ']),
('FL','Florida','Southeast',array['AL','GA']),
('GA','Georgia','Southeast',array['FL','AL','TN','NC','SC']),
('HI','Hawaii','Pacific',array['WA','OR','CA','AK']),
('ID','Idaho','Mountain',array['WA','OR','NV','UT','WY','MT']),
('IL','Illinois','Midwest',array['WI','IA','MO','KY','IN']),
('IN','Indiana','Midwest',array['MI','OH','KY','IL']),
('IA','Iowa','Plains',array['MN','WI','IL','MO','NE','SD']),
('KS','Kansas','Plains',array['NE','MO','OK','CO']),
('KY','Kentucky','South',array['IL','IN','OH','WV','VA','TN','MO']),
('LA','Louisiana','South',array['TX','AR','MS']),
('ME','Maine','Northeast',array['NH']),
('MD','Maryland','Northeast',array['VA','WV','PA','DE']),
('MA','Massachusetts','Northeast',array['RI','CT','NY','VT','NH']),
('MI','Michigan','Midwest',array['WI','IN','OH']),
('MN','Minnesota','Midwest',array['ND','SD','IA','WI']),
('MS','Mississippi','South',array['LA','AR','TN','AL']),
('MO','Missouri','Plains',array['IA','IL','KY','TN','AR','OK','KS','NE']),
('MT','Montana','Mountain',array['ID','WY','SD','ND']),
('NE','Nebraska','Plains',array['SD','IA','MO','KS','CO','WY']),
('NV','Nevada','Mountain',array['OR','ID','UT','AZ','CA']),
('NH','New Hampshire','Northeast',array['ME','MA','VT']),
('NJ','New Jersey','Northeast',array['NY','PA','DE']),
('NM','New Mexico','Southwest',array['AZ','CO','OK','TX']),
('NY','New York','Northeast',array['PA','NJ','CT','MA','VT']),
('NC','North Carolina','Southeast',array['VA','TN','GA','SC']),
('ND','North Dakota','Plains',array['MT','SD','MN']),
('OH','Ohio','Midwest',array['MI','PA','WV','KY','IN']),
('OK','Oklahoma','Southwest',array['CO','KS','MO','AR','TX','NM']),
('OR','Oregon','Pacific',array['WA','ID','NV','CA','AK','HI']),
('PA','Pennsylvania','Northeast',array['NY','NJ','DE','MD','WV','OH']),
('RI','Rhode Island','Northeast',array['CT','MA']),
('SC','South Carolina','Southeast',array['NC','GA']),
('SD','South Dakota','Plains',array['ND','MN','IA','NE','WY','MT']),
('TN','Tennessee','South',array['KY','VA','NC','GA','AL','MS','AR','MO']),
('TX','Texas','Southwest',array['NM','OK','AR','LA']),
('UT','Utah','Mountain',array['ID','WY','CO','AZ','NV']),
('VT','Vermont','Northeast',array['NY','MA','NH']),
('VA','Virginia','Southeast',array['MD','WV','KY','TN','NC']),
('WA','Washington','Pacific',array['ID','OR','AK','HI']),
('WV','West Virginia','South',array['OH','PA','MD','VA','KY']),
('WI','Wisconsin','Midwest',array['MI','MN','IA','IL']),
('WY','Wyoming','Mountain',array['MT','SD','NE','CO','UT','ID']);

-- Starter bank: 550 pre-generated rows so every state can support claims, steals, and defenses.
-- This proves the pipeline and gameplay. Replace/augment with externally validated production batches.
create temporary table seed_facts(territory_id text primary key, sport text, subject text) on commit drop;
insert into seed_facts values
('AL','NCAA Football','Alabama Crimson Tide'),('AK','NCAA Hockey','Alaska Nanooks'),('AZ','NFL','Arizona Cardinals'),('AR','NCAA Football','Arkansas Razorbacks'),('CA','NBA','Los Angeles Lakers'),
('CO','NFL','Denver Broncos'),('CT','NCAA Basketball','UConn Huskies'),('DE','NCAA Football','Delaware Fightin'' Blue Hens'),('FL','NFL','Miami Dolphins'),('GA','MLB','Atlanta Braves'),
('HI','NCAA Football','Hawaii Rainbow Warriors'),('ID','NCAA Football','Boise State Broncos'),('IL','NBA','Chicago Bulls'),('IN','NBA','Indiana Pacers'),('IA','NCAA Football','Iowa Hawkeyes'),
('KS','NCAA Basketball','Kansas Jayhawks'),('KY','NCAA Basketball','Kentucky Wildcats'),('LA','NFL','New Orleans Saints'),('ME','NCAA Hockey','Maine Black Bears'),('MD','NFL','Baltimore Ravens'),
('MA','NBA','Boston Celtics'),('MI','NFL','Detroit Lions'),('MN','NFL','Minnesota Vikings'),('MS','NCAA Football','Ole Miss Rebels'),('MO','NFL','Kansas City Chiefs'),
('MT','NCAA Football','Montana Grizzlies'),('NE','NCAA Football','Nebraska Cornhuskers'),('NV','NFL','Las Vegas Raiders'),('NH','NCAA Hockey','New Hampshire Wildcats'),('NJ','NHL','New Jersey Devils'),
('NM','NCAA Basketball','New Mexico Lobos'),('NY','MLB','New York Yankees'),('NC','NFL','Carolina Panthers'),('ND','NCAA Hockey','North Dakota Fighting Hawks'),('OH','NFL','Cleveland Browns'),
('OK','NCAA Football','Oklahoma Sooners'),('OR','NCAA Football','Oregon Ducks'),('PA','NFL','Pittsburgh Steelers'),('RI','NCAA Basketball','Providence Friars'),('SC','NCAA Football','Clemson Tigers'),
('SD','NCAA Football','South Dakota State Jackrabbits'),('TN','NFL','Tennessee Titans'),('TX','NFL','Dallas Cowboys'),('UT','NBA','Utah Jazz'),('VT','NCAA Basketball','Vermont Catamounts'),
('VA','NCAA Basketball','Virginia Cavaliers'),('WA','NFL','Seattle Seahawks'),('WV','NCAA Football','West Virginia Mountaineers'),('WI','NFL','Green Bay Packers'),('WY','NCAA Football','Wyoming Cowboys');

insert into public.questions(territory_id, sport, link_type, tier, format, question_text, options, correct_answer, aliases)
select f.territory_id, f.sport, 'franchise_college', 1, 'multiple_choice',
  case gs when 1 then format('Which sports team or program is associated with %s?', t.name)
          when 2 then format('Select the team or program linked to %s.', t.name)
          else format('Which answer belongs on a sports trivia card for %s?', t.name) end,
  jsonb_build_array(f.subject, (select f2.subject from seed_facts f2 where f2.territory_id <> f.territory_id order by md5(f.territory_id || f2.territory_id || gs::text) limit 1)),
  f.subject, array[f.subject, regexp_replace(f.subject, '^.* ', '')]
from seed_facts f join public.territories t on t.id = f.territory_id cross join generate_series(1,3) gs;

insert into public.questions(territory_id, sport, link_type, tier, format, question_text, options, correct_answer, aliases)
select f.territory_id, f.sport, 'franchise_college', 2, 'multiple_choice',
  case gs when 1 then format('Which of these teams or programs is most directly associated with %s?', t.name)
          when 2 then format('Identify the sports team or program based in %s.', t.name)
          when 3 then format('Which team or program represents %s in this matchup?', t.name)
          else format('Choose the correct sports organization connected to %s.', t.name) end,
  jsonb_build_array(
    f.subject,
    (select f2.subject from seed_facts f2 where f2.territory_id <> f.territory_id order by md5(f.territory_id || f2.territory_id || gs::text) limit 1 offset 0),
    (select f2.subject from seed_facts f2 where f2.territory_id <> f.territory_id order by md5(f.territory_id || f2.territory_id || gs::text) limit 1 offset 1),
    (select f2.subject from seed_facts f2 where f2.territory_id <> f.territory_id order by md5(f.territory_id || f2.territory_id || gs::text) limit 1 offset 2)
  ),
  f.subject, array[f.subject, regexp_replace(f.subject, '^.* ', '')]
from seed_facts f join public.territories t on t.id = f.territory_id cross join generate_series(1,4) gs;

insert into public.questions(territory_id, sport, link_type, tier, format, question_text, options, correct_answer, aliases)
select f.territory_id, f.sport, 'franchise_college', 3, 'free_fill',
  case gs when 1 then format('Name the team or program associated with %s.', t.name)
          when 2 then format('What sports team or program is linked to %s in this question bank?', t.name)
          when 3 then format('Type the team or program represented by %s.', t.name)
          else format('Without choices: identify the sports organization connected to %s.', t.name) end,
  '[]'::jsonb, f.subject, array[f.subject, regexp_replace(f.subject, '^.* ', '')]
from seed_facts f join public.territories t on t.id = f.territory_id cross join generate_series(1,4) gs;

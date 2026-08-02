create table if not exists public.duels (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  territory_id text references public.territories(id),
  challenger_id uuid not null references public.profiles(id) on delete cascade,
  opponent_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','active','declined','completed','expired')),
  question_ids uuid[] not null,
  challenger_score integer,
  opponent_score integer,
  challenger_time_ms integer,
  opponent_time_ms integer,
  winner_id uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  expires_at timestamptz not null default now() + interval '48 hours',
  completed_at timestamptz,
  check (challenger_id <> opponent_id),
  check (cardinality(question_ids) = 3)
);

create table if not exists public.duel_attempts (
  id uuid primary key default gen_random_uuid(),
  duel_id uuid not null references public.duels(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  question_id uuid not null references public.questions(id),
  answer_text text,
  is_correct boolean,
  response_ms integer,
  served_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '45 seconds',
  answered_at timestamptz,
  unique(duel_id, user_id, question_id)
);

create index if not exists duels_participants_idx on public.duels(season_id, challenger_id, opponent_id, status);
create index if not exists duel_attempts_progress_idx on public.duel_attempts(duel_id, user_id, answered_at);

alter table public.duels enable row level security;
alter table public.duel_attempts enable row level security;

create or replace function public.create_duel(
  p_group_id uuid,
  p_opponent_id uuid,
  p_territory_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_season public.seasons;
  v_questions uuid[];
  v_duel uuid;
  v_opponent_bot boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_opponent_id = v_user then raise exception 'Choose another player'; end if;
  if not public.is_group_member(p_group_id, v_user) or not public.is_group_member(p_group_id, p_opponent_id) then
    raise exception 'Both players must be in this league';
  end if;

  select coalesce(is_bot,false) into v_opponent_bot from public.profiles where id=p_opponent_id;
  if v_opponent_bot then raise exception 'Bots do not accept direct challenges'; end if;

  select * into v_season
  from public.seasons
  where group_id=p_group_id and status='active'
  order by created_at desc limit 1;
  if not found then raise exception 'Active season not found'; end if;

  if exists (
    select 1 from public.duels
    where season_id=v_season.id and status in ('pending','active')
      and ((challenger_id=v_user and opponent_id=p_opponent_id)
        or (challenger_id=p_opponent_id and opponent_id=v_user))
  ) then raise exception 'You already have an open duel with this player'; end if;

  select array_agg(id) into v_questions
  from (
    select q.id
    from public.questions q
    join public.groups g on g.id=p_group_id
    where q.active
      and (p_territory_id is null or q.territory_id=p_territory_id)
      and (q.sport=any(g.sports) or q.sport is null)
    order by random()
    limit 3
  ) selected;

  if coalesce(cardinality(v_questions),0) <> 3 then raise exception 'Not enough questions are available for this duel'; end if;

  insert into public.duels(season_id,territory_id,challenger_id,opponent_id,question_ids)
  values(v_season.id,p_territory_id,v_user,p_opponent_id,v_questions)
  returning id into v_duel;

  insert into public.activity_events(season_id,actor_id,event_type,territory_id,message)
  select v_season.id,v_user,'duel_challenged',p_territory_id,
         format('%s challenged %s to a three-question duel.',challenger.display_name,opponent.display_name)
  from public.profiles challenger, public.profiles opponent
  where challenger.id=v_user and opponent.id=p_opponent_id;

  return v_duel;
end;
$$;

create or replace function public.respond_duel(p_duel_id uuid,p_accept boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_duel public.duels;
begin
  select * into v_duel from public.duels where id=p_duel_id for update;
  if not found or v_duel.opponent_id<>auth.uid() then raise exception 'Duel invitation not found'; end if;
  if v_duel.status<>'pending' then raise exception 'This invitation is already closed'; end if;
  if v_duel.expires_at<=now() then
    update public.duels set status='expired' where id=p_duel_id;
    return 'expired';
  end if;

  update public.duels
  set status=case when p_accept then 'active' else 'declined' end,
      accepted_at=case when p_accept then now() else null end
  where id=p_duel_id;

  return case when p_accept then 'active' else 'declined' end;
end;
$$;

create or replace function public.begin_duel_question(p_duel_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid:=auth.uid();
  v_duel public.duels;
  v_attempt public.duel_attempts;
  v_question public.questions;
  v_question_id uuid;
  v_answered integer;
  v_options jsonb;
begin
  select * into v_duel from public.duels where id=p_duel_id for update;
  if not found or v_user not in (v_duel.challenger_id,v_duel.opponent_id) then raise exception 'Duel not found'; end if;
  if v_duel.status<>'active' then raise exception 'This duel is not active'; end if;

  select * into v_attempt
  from public.duel_attempts
  where duel_id=p_duel_id and user_id=v_user and answered_at is null
  order by served_at desc limit 1;

  if found then
    select * into v_question from public.questions where id=v_attempt.question_id;
  else
    select count(*) into v_answered
    from public.duel_attempts
    where duel_id=p_duel_id and user_id=v_user and answered_at is not null;

    if v_answered>=3 then return jsonb_build_object('status','waiting'); end if;

    v_question_id:=v_duel.question_ids[v_answered+1];
    select * into v_question from public.questions where id=v_question_id;

    insert into public.duel_attempts(duel_id,user_id,question_id,expires_at)
    values(p_duel_id,v_user,v_question_id,now()+interval '45 seconds')
    returning * into v_attempt;
  end if;

  select coalesce(jsonb_agg(value order by random()),'[]'::jsonb) into v_options
  from jsonb_array_elements_text(v_question.options);

  return jsonb_build_object(
    'status','question',
    'duel_id',p_duel_id,
    'question_id',v_question.id,
    'text',v_question.question_text,
    'format',v_question.format,
    'options',v_options,
    'tier',v_question.tier,
    'sport',v_question.sport,
    'expires_at',v_attempt.expires_at,
    'number',(select count(*) from public.duel_attempts where duel_id=p_duel_id and user_id=v_user)
  );
end;
$$;

create or replace function public.submit_duel_answer(
  p_duel_id uuid,
  p_question_id uuid,
  p_answer text,
  p_response_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid:=auth.uid();
  v_duel public.duels;
  v_attempt public.duel_attempts;
  v_question public.questions;
  v_correct boolean;
  v_my_count integer;
  v_other_count integer;
  v_challenger_score integer;
  v_opponent_score integer;
  v_challenger_time integer;
  v_opponent_time integer;
  v_winner uuid;
begin
  select * into v_duel from public.duels where id=p_duel_id for update;
  if not found or v_user not in (v_duel.challenger_id,v_duel.opponent_id) then raise exception 'Duel not found'; end if;
  if v_duel.status<>'active' then raise exception 'This duel is not active'; end if;

  select * into v_attempt
  from public.duel_attempts
  where duel_id=p_duel_id and user_id=v_user and question_id=p_question_id and answered_at is null
  for update;
  if not found then raise exception 'Active duel question not found'; end if;

  select * into v_question from public.questions where id=p_question_id;
  v_correct:=now()<=v_attempt.expires_at and public.answer_matches(v_question,p_answer);

  update public.duel_attempts
  set answer_text=p_answer,is_correct=v_correct,
      response_ms=least(greatest(coalesce(p_response_ms,0),0),45000),answered_at=now()
  where id=v_attempt.id;

  select count(*) into v_my_count from public.duel_attempts where duel_id=p_duel_id and user_id=v_user and answered_at is not null;
  select count(*) into v_other_count from public.duel_attempts where duel_id=p_duel_id and user_id<>v_user and answered_at is not null;

  if v_my_count=3 and v_other_count=3 then
    select count(*) filter(where is_correct),coalesce(sum(response_ms),0)
      into v_challenger_score,v_challenger_time
    from public.duel_attempts where duel_id=p_duel_id and user_id=v_duel.challenger_id;
    select count(*) filter(where is_correct),coalesce(sum(response_ms),0)
      into v_opponent_score,v_opponent_time
    from public.duel_attempts where duel_id=p_duel_id and user_id=v_duel.opponent_id;

    v_winner:=case
      when v_challenger_score>v_opponent_score then v_duel.challenger_id
      when v_opponent_score>v_challenger_score then v_duel.opponent_id
      when v_challenger_time<v_opponent_time then v_duel.challenger_id
      when v_opponent_time<v_challenger_time then v_duel.opponent_id
      else null
    end;

    update public.duels
    set status='completed',challenger_score=v_challenger_score,opponent_score=v_opponent_score,
        challenger_time_ms=v_challenger_time,opponent_time_ms=v_opponent_time,
        winner_id=v_winner,completed_at=now()
    where id=p_duel_id;
  end if;

  return jsonb_build_object(
    'correct',v_correct,
    'correct_answer',v_question.correct_answer,
    'answered',v_my_count,
    'status',case when v_my_count=3 then 'waiting' else 'continue' end
  );
end;
$$;

create or replace function public.get_my_duels(p_group_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',d.id,
    'status',d.status,
    'territory_id',d.territory_id,
    'challenger_id',d.challenger_id,
    'challenger_name',cp.display_name,
    'opponent_id',d.opponent_id,
    'opponent_name',op.display_name,
    'winner_id',d.winner_id,
    'challenger_score',d.challenger_score,
    'opponent_score',d.opponent_score,
    'challenger_time_ms',d.challenger_time_ms,
    'opponent_time_ms',d.opponent_time_ms,
    'my_answered',(select count(*) from public.duel_attempts a where a.duel_id=d.id and a.user_id=auth.uid() and a.answered_at is not null),
    'their_answered',(select count(*) from public.duel_attempts a where a.duel_id=d.id and a.user_id<>auth.uid() and a.answered_at is not null),
    'created_at',d.created_at,
    'expires_at',d.expires_at
  ) order by d.created_at desc),'[]'::jsonb)
  from public.duels d
  join public.seasons s on s.id=d.season_id
  join public.profiles cp on cp.id=d.challenger_id
  join public.profiles op on op.id=d.opponent_id
  where s.group_id=p_group_id and auth.uid() in (d.challenger_id,d.opponent_id);
$$;

revoke all on function public.create_duel(uuid,uuid,text) from public;
revoke all on function public.respond_duel(uuid,boolean) from public;
revoke all on function public.begin_duel_question(uuid) from public;
revoke all on function public.submit_duel_answer(uuid,uuid,text,integer) from public;
revoke all on function public.get_my_duels(uuid) from public;
grant execute on function public.create_duel(uuid,uuid,text) to authenticated;
grant execute on function public.respond_duel(uuid,boolean) to authenticated;
grant execute on function public.begin_duel_question(uuid) to authenticated;
grant execute on function public.submit_duel_answer(uuid,uuid,text,integer) to authenticated;
grant execute on function public.get_my_duels(uuid) to authenticated;

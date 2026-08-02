create table if not exists public.e2e_configuration (
  id boolean primary key default true check (id),
  fixture_token text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.e2e_runs (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_ids uuid[] not null,
  created_at timestamptz not null default now()
);

alter table public.e2e_configuration enable row level security;
alter table public.e2e_runs enable row level security;

create or replace function public.test_submit_answer(p_session_id uuid,p_correct boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.game_sessions;
  v_test boolean;
  v_answer text;
begin
  select * into v_session
  from public.game_sessions
  where id=p_session_id;

  if not found or v_session.user_id<>auth.uid() then raise exception 'Test session not found'; end if;

  select g.test_mode into v_test
  from public.seasons s
  join public.groups g on g.id=s.group_id
  where s.id=v_session.season_id;

  if not coalesce(v_test,false) then raise exception 'Automated answers are restricted to test leagues'; end if;

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

revoke all on function public.test_submit_answer(uuid,boolean) from public;
grant execute on function public.test_submit_answer(uuid,boolean) to authenticated;

-- A random fixture token is provisioned separately and never committed.

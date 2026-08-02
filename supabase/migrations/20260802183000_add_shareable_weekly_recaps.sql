create table if not exists public.league_recaps (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  recap jsonb not null,
  share_token text not null unique default replace(gen_random_uuid()::text,'-',''),
  created_at timestamptz not null default now(),
  unique(season_id,period_end)
);

alter table public.league_recaps enable row level security;

create or replace function public.generate_league_recap(p_season_id uuid,p_period_end date default current_date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season public.seasons;
  v_group public.groups;
  v_start date:=p_period_end-6;
  v_recap jsonb;
  v_id uuid;
begin
  select * into v_season from public.seasons where id=p_season_id;
  if not found then raise exception 'Season not found'; end if;
  select * into v_group from public.groups where id=v_season.group_id;

  select jsonb_build_object(
    'league',v_group.name,
    'season_id',v_season.id,
    'day',v_season.current_day,
    'period_start',v_start,
    'period_end',p_period_end,
    'standings',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'name',p.display_name,
        'score',coalesce(pa.cumulative_score,0),
        'states',(select count(*) from public.season_territories st where st.season_id=v_season.id and st.owner_id=gm.user_id)
      ) order by coalesce(pa.cumulative_score,0) desc,p.display_name),'[]'::jsonb)
      from public.group_members gm
      join public.profiles p on p.id=gm.user_id
      left join public.player_actions pa on pa.season_id=v_season.id and pa.user_id=gm.user_id
      where gm.group_id=v_group.id
    ),
    'best_defender',(
      select jsonb_build_object('name',p.display_name,'defenses',count(*))
      from public.activity_events e
      join public.profiles p on p.id=e.actor_id
      where e.season_id=v_season.id and e.event_type='attack_repelled'
        and e.created_at::date between v_start and p_period_end
      group by p.display_name order by count(*) desc limit 1
    ),
    'most_fought_state',(
      select jsonb_build_object('state',t.name,'attacks',count(*))
      from public.attacks a join public.territories t on t.id=a.territory_id
      where a.season_id=v_season.id and a.created_at::date between v_start and p_period_end
      group by t.name order by count(*) desc limit 1
    ),
    'biggest_steal',(
      select jsonb_build_object('message',e.message,'state',e.territory_id,'at',e.created_at)
      from public.activity_events e
      where e.season_id=v_season.id and e.event_type='state_stolen'
        and e.created_at::date between v_start and p_period_end
      order by e.created_at desc limit 1
    ),
    'map',(
      select coalesce(jsonb_object_agg(st.territory_id,coalesce(p.display_name,'Neutral')),'{}'::jsonb)
      from public.season_territories st
      left join public.profiles p on p.id=st.owner_id
      where st.season_id=v_season.id
    )
  ) into v_recap;

  insert into public.league_recaps(group_id,season_id,period_start,period_end,recap)
  values(v_group.id,v_season.id,v_start,p_period_end,v_recap)
  on conflict(season_id,period_end)
  do update set recap=excluded.recap,created_at=now()
  returning id into v_id;

  insert into public.activity_events(season_id,event_type,message)
  values(v_season.id,'weekly_recap','The weekly Territory recap is ready.');

  return v_id;
end;
$$;

create or replace function public.generate_due_recaps()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_today date;
  v_count integer:=0;
begin
  for v_row in
    select s.id,g.timezone
    from public.seasons s join public.groups g on g.id=s.group_id
    where s.status='active'
  loop
    v_today:=(now() at time zone coalesce(v_row.timezone,'UTC'))::date;
    if extract(isodow from v_today)=1 and not exists(
      select 1 from public.league_recaps where season_id=v_row.id and period_end=v_today
    ) then
      perform public.generate_league_recap(v_row.id,v_today);
      v_count:=v_count+1;
    end if;
  end loop;
  return v_count;
end;
$$;

create or replace function public.get_latest_group_recap(p_group_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select case when public.is_group_member(p_group_id,auth.uid()) then (
    select jsonb_build_object('share_token',share_token,'period_start',period_start,'period_end',period_end)
    from public.league_recaps where group_id=p_group_id order by period_end desc limit 1
  ) else null end;
$$;

create or replace function public.get_public_recap(p_share_token text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'league',g.name,
    'period_start',r.period_start,
    'period_end',r.period_end,
    'recap',r.recap
  )
  from public.league_recaps r join public.groups g on g.id=r.group_id
  where r.share_token=p_share_token;
$$;

create or replace function public.notify_group_of_recap()
returns trigger
language plpgsql
security definer
set search_path = public,extensions
as $$
declare
  v_token text;
begin
  select webhook_token into v_token from public.push_configuration where id=true;
  if v_token is null then return new; end if;

  perform net.http_post(
    url:='https://gduvdnpxgdniogmxxlmg.supabase.co/functions/v1/send-recap-push',
    body:=jsonb_build_object('recap_id',new.id),
    headers:=jsonb_build_object('Content-Type','application/json','x-territory-webhook',v_token),
    timeout_milliseconds:=5000
  );
  return new;
end;
$$;

drop trigger if exists league_recaps_push_trigger on public.league_recaps;
create trigger league_recaps_push_trigger
after insert on public.league_recaps
for each row execute function public.notify_group_of_recap();

revoke all on function public.generate_league_recap(uuid,date) from public;
revoke all on function public.generate_due_recaps() from public;
revoke all on function public.get_latest_group_recap(uuid) from public;
revoke all on function public.get_public_recap(text) from public;
grant execute on function public.generate_league_recap(uuid,date) to service_role;
grant execute on function public.generate_due_recaps() to service_role;
grant execute on function public.get_latest_group_recap(uuid) to authenticated;
grant execute on function public.get_public_recap(text) to anon,authenticated;

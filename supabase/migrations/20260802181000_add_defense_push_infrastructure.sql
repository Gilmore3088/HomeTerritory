create extension if not exists pg_net with schema extensions;

create table if not exists public.push_configuration (
  id boolean primary key default true check (id),
  public_key text not null,
  private_key text not null,
  webhook_token text not null,
  subject text not null default 'https://home-territory.vercel.app',
  updated_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, group_id, endpoint)
);

alter table public.push_configuration enable row level security;
alter table public.push_subscriptions enable row level security;

create policy "players read own push subscriptions"
on public.push_subscriptions for select
to authenticated
using (user_id = auth.uid());

create policy "players insert own push subscriptions"
on public.push_subscriptions for insert
to authenticated
with check (user_id = auth.uid() and public.is_group_member(group_id, auth.uid()));

create policy "players update own push subscriptions"
on public.push_subscriptions for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid() and public.is_group_member(group_id, auth.uid()));

create policy "players delete own push subscriptions"
on public.push_subscriptions for delete
to authenticated
using (user_id = auth.uid());

create or replace function public.get_push_public_key()
returns text
language sql
security definer
set search_path = public
as $$
  select public_key from public.push_configuration where id = true;
$$;

revoke all on function public.get_push_public_key() from public;
grant execute on function public.get_push_public_key() to authenticated;

create or replace function public.upsert_push_subscription(
  p_group_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.is_group_member(p_group_id, auth.uid()) then raise exception 'Group access denied'; end if;

  insert into public.push_subscriptions(user_id, group_id, endpoint, p256dh, auth)
  values(auth.uid(), p_group_id, p_endpoint, p_p256dh, p_auth)
  on conflict (user_id, group_id, endpoint)
  do update set p256dh = excluded.p256dh, auth = excluded.auth, updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.upsert_push_subscription(uuid,text,text,text) from public;
grant execute on function public.upsert_push_subscription(uuid,text,text,text) to authenticated;

create or replace function public.remove_push_subscription(p_endpoint text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.push_subscriptions
  where user_id = auth.uid() and endpoint = p_endpoint;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.remove_push_subscription(text) from public;
grant execute on function public.remove_push_subscription(text) to authenticated;

create or replace function public.notify_defender_of_attack()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text;
  v_url text := 'https://gduvdnpxgdniogmxxlmg.supabase.co/functions/v1/send-defense-push';
begin
  select webhook_token into v_token from public.push_configuration where id = true;
  if v_token is null then return new; end if;

  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('attack_id', new.id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-territory-webhook', v_token
    ),
    timeout_milliseconds := 5000
  );

  return new;
end;
$$;

drop trigger if exists attacks_defense_push_trigger on public.attacks;
create trigger attacks_defense_push_trigger
after insert on public.attacks
for each row execute function public.notify_defender_of_attack();

-- VAPID private material and the random webhook token are provisioned after migration.
-- They are never committed to the repository and remain protected by RLS with no client policy.

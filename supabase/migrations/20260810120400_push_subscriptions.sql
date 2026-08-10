-- Web-push subscriptions (the first notification channel beyond the in-app
-- defense alert). A row is one browser's PushSubscription for one signed-in
-- user; the endpoint URL is unique per browser registration. Players manage
-- only their own rows (subscribe/unsubscribe from the client); the send
-- side runs on the server under the secret key, which bypasses RLS.
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;

create policy "own push subscriptions are readable" on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());
create policy "players add their own push subscriptions" on public.push_subscriptions
  for insert to authenticated with check (user_id = auth.uid());
create policy "players update their own push subscriptions" on public.push_subscriptions
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "players remove their own push subscriptions" on public.push_subscriptions
  for delete to authenticated using (user_id = auth.uid());

revoke all on public.push_subscriptions from public, anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- One defender alert per attack: the notify route claims an attack by
-- stamping this column atomically before sending, so a retried or spoofed
-- client call cannot double-notify.
alter table public.attacks add column defender_notified_at timestamptz;

notify pgrst, 'reload schema';

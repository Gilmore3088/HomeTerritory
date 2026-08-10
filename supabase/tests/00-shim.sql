-- Minimal stand-in for the Supabase platform pieces the migrations reference,
-- so the migration chain and engine tests can run against vanilla PostgreSQL
-- (CI uses the postgres:16 image). Not applied to the real project.
create schema auth;
create table auth.users(
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  email_confirmed_at timestamptz
);
create or replace function auth.uid() returns uuid
language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create publication supabase_realtime;

-- Phase 3 (Trivia Depth), P3a-1: the facts warehouse.
-- Design: docs/superpowers/specs/2026-09-30-p3-trivia-depth-design.md.
--
-- A separate `facts` schema holds every ingested sports/geo fact the
-- question compiler reads. Access model, in depth:
--   * PostgREST will expose the schema (config.toml / dashboard) so the
--     nightly ETL can write through the service key, BUT anon and
--     authenticated get NO privileges here -- not on the schema, not on a
--     single table or function -- so a browser client cannot read a fact
--     or a template even by guessing the profile header.
--   * Every table additionally has RLS enabled with zero policies:
--     belt and suspenders -- even a stray future grant leaves nothing
--     readable until someone also writes a policy.
--   * `public.facts_privilege_audit()` (service-role only) enumerates any
--     anon/authenticated/PUBLIC privilege that ever appears in the schema;
--     tests/db/facts.test.ts asserts the result is empty, so a leak fails
--     CI by default. The guard is born before the data is.
--
-- Entity identity: `id text` -- the Wikidata QID when the entity resolves
-- to one (e.g. 'Q41323'), else a source-scoped key ('lahman:ruthba01').
-- One uniform text key keeps state_links/aliases/prominence polymorphic.
--
-- Provenance: every entity row carries source, source_key, source_url,
-- retrieved_at, confidence, as_of and verified_sources. confidence rules:
-- 'gold' = an official/curated source the spec lists as gold;
-- 'cross_verified' = >=2 independent sources agree (verified_sources);
-- 'single_source' = everything else. Gate B refuses to compile questions
-- from single_source facts.

create schema facts;

-- ---------------------------------------------------------------- entities

create table facts.athletes (
  id text primary key,
  full_name text not null,
  birth_city text,
  birth_state char(2),
  birth_country text,
  birth_date date,
  death_date date,
  sports text[] not null default '{}',
  positions text[] not null default '{}',
  career_start integer,
  career_end integer,
  colleges jsonb not null default '[]',      -- [{name, college_id, from, to}]
  pro_teams jsonb not null default '[]',     -- [{team_id, team_name, league, from, to}]
  hall_of_fame jsonb not null default '[]',  -- [{hof, year}]
  jersey_numbers jsonb not null default '[]',-- [{team_id, number, retired}]
  nicknames text[] not null default '{}',
  source text not null,
  source_key text not null,
  source_url text,
  retrieved_at timestamptz not null default now(),
  confidence text not null default 'single_source'
    check (confidence in ('gold','cross_verified','single_source')),
  as_of date,
  verified_sources text[] not null default '{}',
  unique (source, source_key)
);
create index athletes_birth_state_idx on facts.athletes(birth_state);
create index athletes_name_idx on facts.athletes(full_name);

create table facts.teams (
  id text primary key,
  league text not null,
  name text not null,
  city text,
  state char(2),
  founded integer,
  defunct integer,
  history jsonb not null default '[]',       -- [{name, city, state, from, to}]
  division text,
  conference text,
  college_id text,                            -- CFB/CBB program -> facts.colleges
  source text not null,
  source_key text not null,
  source_url text,
  retrieved_at timestamptz not null default now(),
  confidence text not null default 'single_source'
    check (confidence in ('gold','cross_verified','single_source')),
  as_of date,
  verified_sources text[] not null default '{}',
  unique (source, source_key)
);
create index teams_league_state_idx on facts.teams(league, state);

create table facts.venues (
  id text primary key,
  name text not null,
  former_names jsonb not null default '[]',  -- [{name, from, to}]
  city text,
  state char(2),
  latitude numeric,
  longitude numeric,
  elevation_m numeric,
  capacity integer,
  opened integer,
  closed integer,
  demolished integer,
  tenants jsonb not null default '[]',       -- [{team_id, team_name, league, from, to}]
  source text not null,
  source_key text not null,
  source_url text,
  retrieved_at timestamptz not null default now(),
  confidence text not null default 'single_source'
    check (confidence in ('gold','cross_verified','single_source')),
  as_of date,
  verified_sources text[] not null default '{}',
  unique (source, source_key)
);
create index venues_state_idx on facts.venues(state);

create table facts.championships (
  id text primary key,
  league text not null,
  season text not null,
  year integer not null,
  winner_team_id text,
  winner_name text not null,
  runner_up_team_id text,
  runner_up_name text,
  series_result text,
  mvp_athlete_id text,
  mvp_name text,
  venue_id text,
  notes text,
  source text not null,
  source_key text not null,
  source_url text,
  retrieved_at timestamptz not null default now(),
  confidence text not null default 'single_source'
    check (confidence in ('gold','cross_verified','single_source')),
  as_of date,
  verified_sources text[] not null default '{}',
  unique (league, season),
  unique (source, source_key)
);
create index championships_league_year_idx on facts.championships(league, year);

create table facts.awards (
  id text primary key,
  award text not null,
  league text not null,
  year integer not null,
  winner_athlete_id text,
  winner_name text not null,
  team_or_college text,
  notes text,
  source text not null,
  source_key text not null,
  source_url text,
  retrieved_at timestamptz not null default now(),
  confidence text not null default 'single_source'
    check (confidence in ('gold','cross_verified','single_source')),
  as_of date,
  verified_sources text[] not null default '{}',
  unique (award, league, year, winner_name),
  unique (source, source_key)
);
create index awards_award_year_idx on facts.awards(award, year);

create table facts.drafts (
  id text primary key,
  league text not null,
  year integer not null,
  round integer,
  overall_pick integer not null,
  athlete_id text,
  player_name text not null,
  team_id text,
  team_name text not null,
  college text,
  source text not null,
  source_key text not null,
  source_url text,
  retrieved_at timestamptz not null default now(),
  confidence text not null default 'single_source'
    check (confidence in ('gold','cross_verified','single_source')),
  as_of date,
  verified_sources text[] not null default '{}',
  unique (league, year, overall_pick),
  unique (source, source_key)
);
create index drafts_league_year_idx on facts.drafts(league, year);

create table facts.season_results (
  id text primary key,
  league text not null,
  team_id text,
  team_name text not null,
  season text not null,
  year integer,
  wins integer,
  losses integer,
  ties integer,
  finish text,
  playoff_result text,
  notable text,
  source text not null,
  source_key text not null,
  source_url text,
  retrieved_at timestamptz not null default now(),
  confidence text not null default 'single_source'
    check (confidence in ('gold','cross_verified','single_source')),
  as_of date,
  verified_sources text[] not null default '{}',
  unique (league, season, team_name),
  unique (source, source_key)
);

create table facts.leaders (
  id text primary key,
  scope text not null check (scope in ('career','season','game')),
  league text,
  stat text not null,
  holder_athlete_id text,
  holder_name text not null,
  value text not null,
  year_from integer,
  year_to integer,
  notes text,
  source text not null,
  source_key text not null,
  source_url text,
  retrieved_at timestamptz not null default now(),
  confidence text not null default 'single_source'
    check (confidence in ('gold','cross_verified','single_source')),
  as_of date,
  verified_sources text[] not null default '{}',
  unique (source, source_key)
);

create table facts.events (
  id text primary key,
  sport text,
  league text,
  event_date date,
  year integer,
  title text not null,
  description text not null,
  athletes jsonb not null default '[]',
  teams jsonb not null default '[]',
  venue_id text,
  city text,
  state char(2),
  kind text,
  source text not null,
  source_key text not null,
  source_url text,
  retrieved_at timestamptz not null default now(),
  confidence text not null default 'single_source'
    check (confidence in ('gold','cross_verified','single_source')),
  as_of date,
  verified_sources text[] not null default '{}',
  unique (source, source_key)
);
create index events_state_idx on facts.events(state);

create table facts.colleges (
  id text primary key,
  name text not null,
  city text,
  state char(2),
  nicknames text[] not null default '{}',
  conference text,
  conference_history jsonb not null default '[]',
  rivalries jsonb not null default '[]',     -- [{opponent, game_name, trophy}]
  source text not null,
  source_key text not null,
  source_url text,
  retrieved_at timestamptz not null default now(),
  confidence text not null default 'single_source'
    check (confidence in ('gold','cross_verified','single_source')),
  as_of date,
  verified_sources text[] not null default '{}',
  unique (source, source_key)
);
create index colleges_state_idx on facts.colleges(state);

create table facts.geo (
  id text primary key,
  kind text not null,
  subject text not null,
  state char(2),
  value_num numeric,
  value_text text,
  description text,
  source text not null,
  source_key text not null,
  source_url text,
  retrieved_at timestamptz not null default now(),
  confidence text not null default 'single_source'
    check (confidence in ('gold','cross_verified','single_source')),
  as_of date,
  verified_sources text[] not null default '{}',
  unique (source, source_key)
);

-- ------------------------------------------------------------------ spine

create table facts.state_links (
  entity_type text not null check (entity_type in
    ('athlete','team','venue','championship','award','draft','event','college','leader','season_result')),
  entity_id text not null,
  state char(2) not null,
  link_kind text not null check (link_kind in
    ('team_plays_in','born_in','raised_in','college_in','venue_in',
     'champion_from','drafted_out_of','event_hosted_in','hof_from')),
  strength text not null default 'primary' check (strength in ('primary','secondary')),
  primary key (entity_type, entity_id, state, link_kind)
);
create index state_links_state_idx on facts.state_links(state, strength);

create table facts.aliases (
  entity_type text not null,
  entity_id text not null,
  alias text not null,
  alias_kind text not null default 'alt_label',
  primary key (entity_type, entity_id, alias)
);
create index aliases_entity_idx on facts.aliases(entity_type, entity_id);

create table facts.prominence (
  entity_type text not null,
  entity_id text not null,
  score numeric not null default 0 check (score >= 0 and score <= 1),
  signals jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (entity_type, entity_id)
);

-- ------------------------------------------------------------- templates

-- A template is data. The compiler contract:
--   answer_sql: a self-contained SELECT returning
--     (family_entity text, territory_id char(2), params jsonb,
--      answer text, aliases text[], prominence numeric)
--     -- one row per compilable question instance.
--   distractor_sql: a SELECT with exactly one $1 (jsonb params) placeholder
--     returning (candidate text) ordered most-plausible-first; the compiler
--     takes the first N that survive the alias-collision lint. NULL for
--     free_fill templates.
--   text_template: '{slot}' placeholders resolved against params.
--   family key = slug || ':' || family_entity -- two instances that share
--     it are "the same question in different clothes" and are never both
--     served to one player.
create table facts.question_templates (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  sport text not null,
  link_type text not null,
  format text not null check (format in ('multiple_choice','free_fill')),
  tier_base integer not null check (tier_base between 1 and 3),
  option_count integer not null default 4 check (option_count between 2 and 6),
  text_template text not null,
  answer_sql text not null,
  distractor_sql text,
  constraints jsonb not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  retired_reason text
);

-- ------------------------------------------------------------------- ops

create table facts.etl_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_upserted integer,
  ok boolean,
  error text
);
create index etl_runs_source_idx on facts.etl_runs(source, started_at desc);

create table facts.fact_conflicts (
  id uuid primary key default gen_random_uuid(),
  entity_type text,
  entity_id text,
  field text,
  source_a text,
  value_a text,
  source_b text,
  value_b text,
  kind text not null default 'value_conflict'
    check (kind in ('value_conflict','unresolved_entity','gate_c_flag','template_error')),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text
);

-- ------------------------------------------------------------ privileges

-- RLS on with zero policies: even a stray grant exposes nothing.
alter table facts.athletes enable row level security;
alter table facts.teams enable row level security;
alter table facts.venues enable row level security;
alter table facts.championships enable row level security;
alter table facts.awards enable row level security;
alter table facts.drafts enable row level security;
alter table facts.season_results enable row level security;
alter table facts.leaders enable row level security;
alter table facts.events enable row level security;
alter table facts.colleges enable row level security;
alter table facts.geo enable row level security;
alter table facts.state_links enable row level security;
alter table facts.aliases enable row level security;
alter table facts.prominence enable row level security;
alter table facts.question_templates enable row level security;
alter table facts.etl_runs enable row level security;
alter table facts.fact_conflicts enable row level security;

revoke all on schema facts from public;
revoke all on all tables in schema facts from public, anon, authenticated;
grant usage on schema facts to service_role;
grant all on all tables in schema facts to service_role;
grant all on all sequences in schema facts to service_role;
alter default privileges in schema facts grant all on tables to service_role;
alter default privileges in schema facts grant all on sequences to service_role;
alter default privileges in schema facts grant execute on functions to service_role;

-- The leak guard. Enumerates every privilege any client-side role (or
-- PUBLIC) holds on anything in the facts schema; the DB suite asserts the
-- result is empty, so a future migration that leaks fails CI by default.
create or replace function public.facts_privilege_audit()
returns table (object_kind text, object_name text, grantee text, privilege text)
language sql
stable
security definer
set search_path = public
as $$
  select 'table', table_name::text, grantee::text, privilege_type::text
  from information_schema.role_table_grants
  where table_schema = 'facts'
    and grantee in ('anon', 'authenticated', 'PUBLIC')
  union all
  select 'function', routine_name::text, grantee::text, privilege_type::text
  from information_schema.routine_privileges
  where routine_schema = 'facts'
    and grantee in ('anon', 'authenticated', 'PUBLIC')
  union all
  select 'schema', 'facts', r.rolname, 'USAGE'
  from pg_namespace n
  cross join (values ('anon'), ('authenticated')) as r(rolname)
  where n.nspname = 'facts'
    and has_schema_privilege(r.rolname, 'facts', 'USAGE');
$$;

revoke all on function public.facts_privilege_audit() from public, anon, authenticated;
grant execute on function public.facts_privilege_audit() to service_role;

notify pgrst, 'reload schema';

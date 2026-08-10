-- Two writers the engine's readers have been waiting for.
--
-- 1. `groups.season_length` still carried the initial schema's
--    `in (14, 30, 60)` check while `create_group_v2` validates
--    `in (7, 10, 14, 30, 60)` -- a 7- or 10-day league passed the RPC's
--    validation and then died on the table constraint. Latent only because
--    the UI hardcoded 14.
--
-- 2. `groups.timezone` drives every group-local day boundary
--    (`group_local_date`, scoring, fortify-once-per-day, action refresh)
--    but nothing ever wrote it, so every league scored on the
--    `America/Los_Angeles` default. `create_group_v2` now takes a
--    validated `p_timezone` (closes backlog P2-timezone). The old
--    7-argument signature is dropped rather than left as an overload:
--    PostgREST refuses ambiguous overloaded RPC calls, and one canonical
--    signature keeps tests/db/audit.test.ts's client-callable allowlist
--    exact. Body transcribed from the live definition
--    (20260730082000_handoff_setup_and_season.sql); only the timezone
--    validation and the insert's timezone column are new.

alter table public.groups drop constraint groups_season_length_check;
alter table public.groups add constraint groups_season_length_check
  check (season_length in (7, 10, 14, 30, 60));

drop function if exists public.create_group_v2(text, text[], integer, text, text, text, boolean);

create function public.create_group_v2(
  p_name text,
  p_sports text[],
  p_season_length integer default 14,
  p_opening_mode text default 'open',
  p_board_scope text default 'fifty',
  p_difficulty text default 'standard',
  p_test_mode boolean default false,
  p_timezone text default 'America/Los_Angeles'
)
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
  if p_season_length not in (7, 10, 14, 30, 60) then raise exception 'Invalid season length'; end if;
  if p_opening_mode not in ('open','dealt') then raise exception 'Invalid opening mode'; end if;
  if p_board_scope not in ('fifty','lower48') then raise exception 'Invalid board scope'; end if;
  if p_difficulty not in ('casual','standard','hardcore') then raise exception 'Invalid difficulty'; end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'Invalid timezone';
  end if;

  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists(select 1 from public.groups where invite_code = v_code);
  end loop;

  insert into public.groups(name, commissioner_id, invite_code, sports, season_length, opening_mode, board_scope, difficulty, test_mode, timezone)
  values (trim(p_name), v_user, v_code, p_sports, p_season_length, p_opening_mode, p_board_scope, p_difficulty, p_test_mode, p_timezone)
  returning id into v_group;

  insert into public.group_members(group_id, user_id, color_index) values (v_group, v_user, 0);
  return v_group;
end;
$$;

revoke execute on function public.create_group_v2(text, text[], integer, text, text, text, boolean, text) from public, anon;
grant execute on function public.create_group_v2(text, text[], integer, text, text, text, boolean, text) to authenticated;

notify pgrst, 'reload schema';

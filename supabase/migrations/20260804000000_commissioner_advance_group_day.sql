-- Phase 2a Task 2: commissioner-gated `advance_group_day(p_group_id uuid)`.
--
-- Task 7's UI will call this directly from the browser's `authenticated`
-- session (unlike `advance_season`, which stays service_role-only and is
-- invoked here server-side via `perform`). It resolves the caller's group,
-- confirms they are its commissioner, finds the group's active season, and
-- delegates all resolve/score/advance work to `advance_season` -- so the
-- once-per-group-local-day scoring guard on `seasons.last_scored_on` (Task 1)
-- is inherited for free rather than re-implemented here.
create or replace function public.advance_group_day(p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_commish uuid;
  v_season_id uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;
  select commissioner_id into v_commish from public.groups where id = p_group_id;
  if v_commish is null then
    raise exception 'Group not found';
  end if;
  if v_commish <> v_uid then
    raise exception 'Only the commissioner can advance the day';
  end if;
  select id into v_season_id from public.seasons
    where group_id = p_group_id and status = 'active' limit 1;
  if v_season_id is null then
    raise exception 'No active season';
  end if;
  perform public.advance_season(v_season_id);
  return jsonb_build_object('ok', true, 'season_id', v_season_id);
end;
$$;

-- Grant hygiene (Phase-1 convention, see 20260803180300_fix_security_definer_grants.sql):
-- client-callable from the game shell, but the function self-checks the
-- caller is the group's commissioner before doing anything.
revoke execute on function public.advance_group_day(uuid) from public, anon;
grant execute on function public.advance_group_day(uuid) to authenticated;

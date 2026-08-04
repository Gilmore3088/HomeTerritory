-- Findings 6 and 7 are one root cause. Supabase's default privileges grant
-- EXECUTE on every new function to `anon` and `authenticated`, so
-- `revoke all on function ... from public` removes nothing that matters: PUBLIC
-- and the two roles are separate grantees. Four security-definer functions were
-- left reachable by an unauthenticated client:
--
--   run_test_bot_turns        finding 6 -- no caller check at all
--   end_test_turn             finding 7 -- saved only by its internal auth guard
--   enforce_test_turn_session trigger function
--   sync_question_attempt_stats  trigger function
--
-- The convention from here on is `revoke ... from public, anon, authenticated`
-- followed by an explicit grant to the roles that genuinely need it. The
-- `security_definer_grants()` report below lets the test suite enforce that on
-- every future migration rather than trusting the next author to remember.
--
-- `run_test_bot_turns` is an internal helper: `run_daily_tick` drives it, and no
-- client calls it. Revoking is therefore the complete fix -- adding an
-- `auth.uid()` caller check instead would break the tick, which runs with no
-- authenticated user.

revoke all on function public.run_test_bot_turns(uuid) from public, anon, authenticated;
grant execute on function public.run_test_bot_turns(uuid) to service_role;

revoke all on function public.end_test_turn(uuid) from public, anon;
grant execute on function public.end_test_turn(uuid) to authenticated;

revoke all on function public.enforce_test_turn_session() from public, anon, authenticated;
revoke all on function public.sync_question_attempt_stats() from public, anon, authenticated;

-- Reports EXECUTE grants on every security-definer function in `public` so
-- tests/db can assert the allowlist. Deliberately SECURITY INVOKER, so it does
-- not enumerate itself, and readable only by the service key.
create or replace function public.security_definer_grants()
returns jsonb
language sql
stable
set search_path = public, pg_catalog
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
        'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
        'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )
      order by p.proname
    ),
    '[]'::jsonb
  )
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef;
$$;

revoke all on function public.security_definer_grants() from public, anon, authenticated;
grant execute on function public.security_definer_grants() to service_role;

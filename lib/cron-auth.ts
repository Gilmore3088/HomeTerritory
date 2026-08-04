/**
 * The daily tick runs `run_daily_tick()` under the service-role key, so the only
 * thing standing between the internet and a forced day advance is this check.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on every scheduled
 * invocation, so the shared secret is the whole contract. `x-vercel-cron-*`
 * headers are caller-controlled and are deliberately not consulted.
 */
export function isAuthorizedCronRequest(
  requestHeaders: Headers,
  cronSecret: string | undefined,
): boolean {
  if (!cronSecret) return false;
  return requestHeaders.get("authorization") === `Bearer ${cronSecret}`;
}

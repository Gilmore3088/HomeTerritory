export function shouldClearOperation(input: {
  serverHasSession: boolean;
  beganAtMs: number | null;
  loadStartedAtMs: number;
}): boolean {
  if (input.serverHasSession) return false;
  if (input.beganAtMs !== null && input.beganAtMs >= input.loadStartedAtMs) return false;
  return true;
}

export function unseenActivityCount(
  activity: Array<{ created_at: string }>,
  lastSeenIso: string | null,
): number {
  if (!lastSeenIso) return activity.length;
  const cutoff = new Date(lastSeenIso).getTime();
  return activity.filter((row) => new Date(row.created_at).getTime() > cutoff).length;
}

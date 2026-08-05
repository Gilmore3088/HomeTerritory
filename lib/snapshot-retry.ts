// Pure decision logic for the snapshot loader, kept out of the hook so the
// contract is unit-testable without Supabase (same habit as turn-reconcile).

// Two consecutive failures with nothing on screen means the player is looking
// at an infinite splash; that is when the error screen takes over. A single
// failure stays a toast because the ungated 20s poll retries on its own.
export const SNAPSHOT_ERROR_THRESHOLD = 2;

export function shouldShowLoadError(consecutiveFailures: number, hasSnapshot: boolean): boolean {
  return consecutiveFailures >= SNAPSHOT_ERROR_THRESHOLD && !hasSnapshot;
}

// A response is stale when the load generation moved while it was in flight
// (the player switched leagues). Generation is a monotonic counter, not a
// timestamp: two switches in one millisecond must still invalidate.
export function isStaleLoad(requestGeneration: number, currentGeneration: number): boolean {
  return requestGeneration !== currentGeneration;
}

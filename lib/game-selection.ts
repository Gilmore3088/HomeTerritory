export interface SelectableGroup {
  id: string;
  status?: string;
}

const ACTIVE_STATUS = "active";

/**
 * Picks which group id should be considered "current" out of the user's
 * fetched group list. A saved or preferred id is only honored when it names
 * a row the caller actually has (Finding 22): trusting an id that is not in
 * `rows` lets a stale id survive removal/deletion/account-switch and wedge
 * the caller on a group the RPC layer will reject.
 */
export function pickActiveGroup(
  rows: Array<SelectableGroup>,
  saved: string | null,
  preferred?: string | null,
): string | null {
  if (preferred && rows.some((row) => row.id === preferred)) return preferred;
  if (saved && rows.some((row) => row.id === saved)) return saved;
  return rows.find((row) => row.status === ACTIVE_STATUS)?.id ?? rows[0]?.id ?? null;
}

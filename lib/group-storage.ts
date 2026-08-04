// The saved league selection is scoped per account. The unscoped legacy key
// predates account scoping and is deleted rather than migrated: migrating
// would hand whichever account reads it first the previous account's league,
// and the worst case of deletion is re-picking a league once.
const LEGACY_KEY = "territory_group";

const scopedKey = (userId: string) => `territory_group:${userId}`;

export function readSavedGroupId(userId: string): string | null {
  window.localStorage.removeItem(LEGACY_KEY);
  return window.localStorage.getItem(scopedKey(userId));
}

export function writeSavedGroupId(userId: string, groupId: string): void {
  window.localStorage.setItem(scopedKey(userId), groupId);
}

export function clearSavedGroupId(userId: string): void {
  window.localStorage.removeItem(scopedKey(userId));
}

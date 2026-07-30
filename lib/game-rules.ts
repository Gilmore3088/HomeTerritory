export type HoldLevel = 1 | 2 | 3;

export function requiredCorrectForSteal(
  holdLevel: HoldLevel,
  isUnderdog: boolean,
): number {
  const base = holdLevel === 1 ? 2 : 3;
  return Math.max(1, base - (isUnderdog ? 1 : 0));
}

export function tierForSteal(holdLevel: HoldLevel): 2 | 3 {
  return holdLevel === 3 ? 3 : 2;
}

export function normalizeAnswer(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canAttackTerritory(input: {
  targetId: string;
  ownedTerritoryIds: string[];
  adjacencyByTerritory: Record<string, string[]>;
}): boolean {
  if (input.ownedTerritoryIds.length === 0) return true;
  return input.ownedTerritoryIds.some((ownedId) =>
    (input.adjacencyByTerritory[ownedId] ?? []).includes(input.targetId),
  );
}

export function refreshedActions(input: {
  currentActions: number;
  elapsedDays: number;
}): number {
  return Math.min(5, input.currentActions + Math.max(0, input.elapsedDays) * 3);
}

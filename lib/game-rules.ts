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

/** Claim, attack and fortify each spend one of the day's moves. */
export function actionSpendsMove(kind: string): boolean {
  return kind === "claim" || kind === "attack" || kind === "fortify";
}

/** Only offensive moves need a shared border; you can always reach your own states. */
export function actionRequiresBorder(kind: string): boolean {
  return kind === "claim" || kind === "attack";
}

// Blocking precedence (shared with the upcoming blockedReason helper):
// contested > not-your-turn > no-actions > no-border. Defense is exempt from
// the turn gate and never spends a move, so only move-spending actions check
// the turn.
export function isTerritoryActionBlocked(input: {
  kind: string;
  contested: boolean;
  sharesBorder: boolean;
  actionsRemaining: number;
  isMyTurn?: boolean;
}): boolean {
  if (input.contested) return true;
  if (actionSpendsMove(input.kind) && input.isMyTurn === false) return true;
  if (actionSpendsMove(input.kind) && input.actionsRemaining < 1) return true;
  return actionRequiresBorder(input.kind) && !input.sharesBorder;
}

export function refreshedActions(input: {
  currentActions: number;
  elapsedDays: number;
}): number {
  return Math.min(5, input.currentActions + Math.max(0, input.elapsedDays) * 3);
}

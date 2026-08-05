// Player-facing copy decisions, kept pure so the arena and sheet stay thin.

export interface ResultCopyInput {
  status: string;
  timedOut: boolean;
  actionType?: string;
}

export function resultCopy(input: ResultCopyInput): { title: string; message: string } {
  if (input.timedOut) {
    if (input.actionType === "defend") {
      return {
        title: "Time ran out",
        message: "The clock beat your defense. The attacker takes the state.",
      };
    }
    return {
      title: "Time's up",
      message: "The clock ran out before an answer landed. The map does not change.",
    };
  }
  if (input.status === "contested") {
    return { title: "Challenge issued", message: "Your run is complete. The defender is on the clock." };
  }
  if (input.status === "failed") {
    return { title: "Operation failed", message: "Incorrect. The map does not change." };
  }
  return { title: "Territory secured", message: "Correct. The map is yours to shape." };
}

export interface BlockedReasonInput {
  hasAction: boolean;
  actionsRemaining: number;
  contested: boolean;
  canTarget: boolean;
  isMyTurn: boolean;
  turnHolderName?: string | null;
  kind?: string;
}

/** The one sentence every off-turn surface uses. */
export function waitingCopy(turnHolderName?: string | null): string {
  return `It's ${turnHolderName ?? "another player"}'s turn. You can defend if attacked.`;
}

export const NO_BORDER_COPY = "You don't share a border with this state.";

// THE precedence ladder — lib/game-rules.ts's isTerritoryActionBlocked is
// derived from this, so a disabled button and its caption cannot disagree.
// Order: contested > not-your-turn > no-moves > no-border > actionable.
// Defense never spends a move and is exempt from the turn gate.
export function blockedReason(input: BlockedReasonInput): string | null {
  if (!input.hasAction) return null;
  if (input.contested) return "An attack is already active here.";
  const spendsMove = input.kind === undefined
    || input.kind === "claim" || input.kind === "attack" || input.kind === "fortify";
  if (spendsMove && !input.isMyTurn) return waitingCopy(input.turnHolderName);
  if (spendsMove && input.actionsRemaining < 1) return "No moves left today.";
  if (!input.canTarget && (input.kind === "claim" || input.kind === "attack" || input.kind === undefined)) {
    return NO_BORDER_COPY;
  }
  return null;
}

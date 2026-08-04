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
  onCooldown?: boolean;
  alreadyFortifiedToday?: boolean;
  kind?: string;
}

// Precedence mirrors lib/game-rules.ts: contested > not-your-turn >
// no-actions > cooldown > already-fortified > no-border > actionable.
export function blockedReason(input: BlockedReasonInput): string | null {
  if (!input.hasAction) return null;
  if (input.contested) return "An attack is already active here.";
  if (!input.isMyTurn) {
    return `It's ${input.turnHolderName ?? "another player"}'s turn. You can defend if attacked.`;
  }
  if (input.actionsRemaining < 1) return "No moves left today.";
  if (input.onCooldown) return "This state is cooling down after a missed claim.";
  if (input.alreadyFortifiedToday && input.kind === "fortify") return "You already fortified this state today.";
  if (!input.canTarget && (input.kind === "claim" || input.kind === "attack" || input.kind === undefined)) {
    return "You don't share a border with this state.";
  }
  return null;
}

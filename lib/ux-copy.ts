import { actionRequiresBorder, actionSpendsMove } from "@/lib/game-rules";

/**
 * Result-screen copy. A timed-out question gets its own verdict so a player
 * who ran out of clock can tell that apart from answering wrong; every other
 * outcome keeps the server's message when one exists (the caller overlays
 * it), with these as the fallback lines.
 */
export function resultCopy(input: { status: string; timedOut: boolean }): { title: string; message: string } {
  if (input.timedOut) {
    return {
      title: "Time's up",
      message: input.status === "failed"
        ? "The clock ran out before an answer landed. The map does not change."
        : "The clock ran out before an answer landed.",
    };
  }
  switch (input.status) {
    case "contested":
      return { title: "Challenge issued", message: "The defender is on the clock." };
    case "completed":
      return { title: "Territory secured", message: "The map changed." };
    case "void":
      return { title: "No harm done", message: "The situation changed before your answer landed. Your move was returned." };
    default:
      return { title: "Operation failed", message: "The map did not move." };
  }
}

/**
 * Why a territory action button is disabled, in words — or null when the
 * action is playable. Precedence: contested > no moves > cooldown >
 * already fortified > no shared border.
 */
export function blockedReason(input: {
  hasAction: boolean;
  actionsRemaining: number;
  contested: boolean;
  canTarget: boolean;
  onCooldown?: boolean;
  alreadyFortifiedToday?: boolean;
  kind?: string;
}): string | null {
  if (!input.hasAction) return null;
  const kind = input.kind ?? "claim";
  if (input.contested) return "An attack is already active here.";
  if (actionSpendsMove(kind) && input.actionsRemaining < 1) {
    return "No moves left today. Defending is still free.";
  }
  if (input.onCooldown) return "This state is cooling down after a missed claim.";
  if (input.alreadyFortifiedToday) return "You already fortified this state today.";
  if (actionRequiresBorder(kind) && !input.canTarget) return "You do not share a border with this state.";
  return null;
}

export function dayNumber(
  season: { started_at: string; current_day?: number } | null,
  now: number = Date.now(),
): number {
  if (!season) return 0;
  if (season.current_day) return season.current_day;
  return Math.max(1, Math.floor((now - new Date(season.started_at).getTime()) / 86_400_000) + 1);
}

export function timeLeft(value: string, now: number = Date.now()): string {
  const ms = new Date(value).getTime() - now;
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export async function edgeErrorMessage(error: unknown): Promise<string> {
  if (error && typeof error === "object" && "context" in error) {
    const response = (error as { context?: Response }).context;
    if (response) {
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) return body.error;
      } catch {
        // Fall through to the normal Error message.
      }
    }
  }
  return error instanceof Error ? error.message : "The request could not be completed.";
}

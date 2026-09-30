// State utilities for entity resolution. Standalone (no app imports) so
// ETL scripts run under plain `node --experimental-strip-types`.
export const STATE_BY_NAME: Record<string, string> = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
  "colorado": "CO", "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA",
  "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
  "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO",
  "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH",
  "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
  "virginia": "VA", "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
};

export const ALL_STATE_CODES = new Set(Object.values(STATE_BY_NAME));

/** "Massachusetts" -> "MA"; "Washington, D.C." and unknowns -> null. */
export function stateCode(name: string | null | undefined): string | null {
  if (!name) return null;
  const normalized = name.trim().toLowerCase().replace(/^state of /, "");
  return STATE_BY_NAME[normalized] ?? null;
}

/** Point-in-state via bounding boxes is unreliable; resolution happens via
 * Wikidata's admin hierarchy instead. This validates codes coming back. */
export function isStateCode(code: string | null | undefined): code is string {
  return typeof code === "string" && ALL_STATE_CODES.has(code);
}

import mapData from "@/data/us-states";
import adjacencyData from "@/data/adjacency.json";
import type { Member, ScoreRow } from "@/lib/game-types";

export const PATHS = mapData.paths as Record<string, string>;
export const CENTROIDS = mapData.centroids as Record<string, [number, number]>;
export const ADJ = adjacencyData.adjacency as Record<string, string[]>;
export const PLAYER_COLORS = [
  "#1D6FE0",
  "#E0332F",
  "#1F9D57",
  "#E8A020",
  "#7A4BD0",
  "#138A95",
  "#E2622F",
  "#41506A",
];
export const NEUTRAL = "#E7E3D8";
export const PAPER = "#FAF7EF";
export const INK = "#111111";
export const DANGER = "#E0332F";

export const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
export const ALL_STATES = Object.keys(STATE_NAMES).sort((a, b) => STATE_NAMES[a].localeCompare(STATE_NAMES[b]));
export const MAP_LABELS = ALL_STATES.filter((code) => !["CT", "DE", "MA", "MD", "NH", "NJ", "RI", "VT", "WV"].includes(code));
export const LEADERS: Record<string, number> = { VT: 132, NH: 158, MA: 184, RI: 210, CT: 236, NJ: 262, DE: 288, MD: 314, WV: 340 };
export const SPORTS = ["NFL", "CFB", "MLB", "NBA", "CBB", "NHL", "OTH"];

export function memberColor(member?: Pick<Member, "color_index"> | Pick<ScoreRow, "color_index"> | null) {
  return PLAYER_COLORS[member?.color_index ?? 0] ?? PLAYER_COLORS[0];
}

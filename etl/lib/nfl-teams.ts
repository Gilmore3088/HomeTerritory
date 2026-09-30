// PFR-style NFL team codes -> era-correct franchise names, derived from the
// actual nflverse draft_picks.csv code/season ranges (observed 2026-09-30:
// 38 codes, seasons 1980-2026). A (code, season) pair outside these ranges
// resolves to null and the fact ships as single_source, which Gate B keeps
// out of compiled questions until a human maps it -- never a guessed name.
interface Era { name: string; from: number; to: number }

const ERAS: Record<string, Era[]> = {
  ARI: [{ name: "Arizona Cardinals", from: 1994, to: 9999 }],
  PHO: [{ name: "Phoenix Cardinals", from: 1988, to: 1993 }],
  ATL: [{ name: "Atlanta Falcons", from: 1966, to: 9999 }],
  BAL: [
    { name: "Baltimore Colts", from: 1953, to: 1983 },
    { name: "Baltimore Ravens", from: 1996, to: 9999 },
  ],
  BUF: [{ name: "Buffalo Bills", from: 1960, to: 9999 }],
  CAR: [{ name: "Carolina Panthers", from: 1995, to: 9999 }],
  CHI: [{ name: "Chicago Bears", from: 1920, to: 9999 }],
  CIN: [{ name: "Cincinnati Bengals", from: 1968, to: 9999 }],
  CLE: [{ name: "Cleveland Browns", from: 1946, to: 9999 }],
  DAL: [{ name: "Dallas Cowboys", from: 1960, to: 9999 }],
  DEN: [{ name: "Denver Broncos", from: 1960, to: 9999 }],
  DET: [{ name: "Detroit Lions", from: 1934, to: 9999 }],
  GNB: [{ name: "Green Bay Packers", from: 1921, to: 9999 }],
  HOU: [
    { name: "Houston Oilers", from: 1960, to: 1996 },
    { name: "Houston Texans", from: 2002, to: 9999 },
  ],
  IND: [{ name: "Indianapolis Colts", from: 1984, to: 9999 }],
  JAX: [{ name: "Jacksonville Jaguars", from: 1995, to: 9999 }],
  KAN: [{ name: "Kansas City Chiefs", from: 1963, to: 9999 }],
  LAC: [{ name: "Los Angeles Chargers", from: 2017, to: 9999 }],
  LAR: [{ name: "Los Angeles Rams", from: 2016, to: 9999 }],
  LVR: [{ name: "Las Vegas Raiders", from: 2020, to: 9999 }],
  MIA: [{ name: "Miami Dolphins", from: 1966, to: 9999 }],
  MIN: [{ name: "Minnesota Vikings", from: 1961, to: 9999 }],
  NOR: [{ name: "New Orleans Saints", from: 1967, to: 9999 }],
  NWE: [{ name: "New England Patriots", from: 1971, to: 9999 }],
  NYG: [{ name: "New York Giants", from: 1925, to: 9999 }],
  NYJ: [{ name: "New York Jets", from: 1963, to: 9999 }],
  OAK: [{ name: "Oakland Raiders", from: 1960, to: 2019 }],
  RAI: [{ name: "Los Angeles Raiders", from: 1982, to: 1994 }],
  RAM: [{ name: "Los Angeles Rams", from: 1946, to: 1994 }],
  PHI: [{ name: "Philadelphia Eagles", from: 1933, to: 9999 }],
  PIT: [{ name: "Pittsburgh Steelers", from: 1933, to: 9999 }],
  SDG: [{ name: "San Diego Chargers", from: 1961, to: 2016 }],
  SEA: [{ name: "Seattle Seahawks", from: 1976, to: 9999 }],
  SFO: [{ name: "San Francisco 49ers", from: 1946, to: 9999 }],
  STL: [
    { name: "St. Louis Cardinals", from: 1960, to: 1987 },
    { name: "St. Louis Rams", from: 1995, to: 2015 },
  ],
  TAM: [{ name: "Tampa Bay Buccaneers", from: 1976, to: 9999 }],
  TEN: [
    { name: "Tennessee Oilers", from: 1997, to: 1998 },
    { name: "Tennessee Titans", from: 1999, to: 9999 },
  ],
  WAS: [
    { name: "Washington Redskins", from: 1937, to: 2019 },
    { name: "Washington Football Team", from: 2020, to: 2021 },
    { name: "Washington Commanders", from: 2022, to: 9999 },
  ],
};

export function nflTeamName(code: string, season: number): string | null {
  const eras = ERAS[code];
  if (!eras) return null;
  const era = eras.find((e) => season >= e.from && season <= e.to);
  return era ? era.name : null;
}

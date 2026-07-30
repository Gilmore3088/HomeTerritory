export type Member = {
  user_id: string;
  display_name: string;
  color_index: number;
};

export type TerritorySnapshot = {
  id: string;
  name: string;
  region: string;
  adjacent: string[];
  owner_id: string | null;
  hold_level: 1 | 2 | 3;
  contested: boolean;
};

export type AttackSnapshot = {
  id: string;
  territory_id: string;
  attacker_id: string;
  defender_id: string;
  status: string;
  defense_deadline: string;
  tier: 2 | 3;
};

export type ScoreSnapshot = {
  user_id: string;
  display_name: string;
  color_index: number;
  cumulative_score: number;
  state_count: number;
};

export type ActivitySnapshot = {
  id: string;
  message: string;
  created_at: string;
  territory_id: string | null;
};

export type SeasonSnapshot = {
  id: string;
  status: "active" | "ended";
  started_at: string;
  ends_at: string;
};

export type GameSnapshot = {
  current_user_id: string;
  group: {
    id: string;
    name: string;
    commissioner_id: string;
    invite_code: string;
    sports: string[];
    status: string;
  };
  season: SeasonSnapshot | null;
  members: Member[];
  territories: TerritorySnapshot[];
  attacks: AttackSnapshot[];
  scores: ScoreSnapshot[];
  activity: ActivitySnapshot[];
  actions_remaining: number;
};

export type QuestionPayload = {
  attempt_id: string;
  text: string;
  format: "multiple_choice" | "free_fill";
  options: string[];
  tier: 1 | 2 | 3;
  sport: string;
  link_type: string;
  expires_at: string;
};

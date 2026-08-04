export interface GroupRow {
  id: string;
  name: string;
  status: "lobby" | "active" | "ended";
  invite_code: string;
  sports: string[];
  member_count: number;
  is_commissioner: boolean;
}
export interface Member {
  user_id: string;
  display_name: string;
  color_index: number;
  home_state?: string | null;
  home_completed?: boolean;
  is_bot?: boolean;
}
export interface Territory {
  id: string;
  name: string;
  region: string;
  adjacent: string[];
  owner_id: string | null;
  hold_level: number;
  contested: boolean;
}
export interface Attack {
  id: string;
  territory_id: string;
  attacker_id: string;
  defender_id: string;
  status: string;
  defense_deadline: string;
  tier: number;
}
export interface ScoreRow {
  user_id: string;
  display_name: string;
  color_index: number;
  cumulative_score: number;
  state_count: number;
}
export interface FeedRow {
  id: string;
  message: string;
  created_at: string;
  territory_id?: string | null;
}
export interface Snapshot {
  current_user_id: string;
  group: {
    id: string;
    name: string;
    commissioner_id: string;
    invite_code: string;
    sports: string[];
    status: string;
    test_mode?: boolean;
  };
  season: null | {
    id: string;
    status: string;
    started_at: string;
    ends_at: string;
    current_day?: number;
  };
  members: Member[];
  territories: Territory[];
  attacks: Attack[];
  scores: ScoreRow[];
  activity: FeedRow[];
  actions_remaining: number;
}
export interface Question {
  attempt_id: string;
  text: string;
  format: "multiple_choice" | "free_fill";
  options: string[];
  tier: number;
  sport: string;
  link_type: string;
  expires_at: string;
}
export interface ActiveOperation {
  session_id: string;
  action_type: string;
  territory_id: string;
  required_correct: number;
  correct_count: number;
  question: Question;
}
export interface ResultState {
  ok: boolean;
  title: string;
  message: string;
  correctAnswer?: string | null;
}
export interface ToastState { text: string; error?: boolean }

export type View = "map" | "standings" | "feed";

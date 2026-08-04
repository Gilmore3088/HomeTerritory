"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { dayNumber, edgeErrorMessage, timeLeft } from "@/lib/game-format";
import { isTerritoryActionBlocked } from "@/lib/game-rules";
import mapData from "@/data/us-states";
import adjacencyData from "@/data/adjacency.json";
import styles from "./territory-game-v2.module.css";

const supabase = createClient();

const PATHS = mapData.paths as Record<string, string>;
const CENTROIDS = mapData.centroids as Record<string, [number, number]>;
const ADJ = adjacencyData.adjacency as Record<string, string[]>;
const PLAYER_COLORS = [
  "#0B6E99",
  "#7A4CB4",
  "#1F8A5B",
  "#D18B16",
  "#D74B4B",
  "#168B95",
  "#B55E32",
  "#52677F",
];
const NEUTRAL = "#D8D9D2";
const INK = "#142034";
const DANGER = "#E34A34";

const STATE_NAMES: Record<string, string> = {
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
const ALL_STATES = Object.keys(STATE_NAMES).sort((a, b) => STATE_NAMES[a].localeCompare(STATE_NAMES[b]));
const MAP_LABELS = ALL_STATES.filter((code) => !["CT", "DE", "MA", "MD", "NH", "NJ", "RI", "VT", "WV"].includes(code));
const LEADERS: Record<string, number> = { VT: 132, NH: 158, MA: 184, RI: 210, CT: 236, NJ: 262, DE: 288, MD: 314, WV: 340 };
const SPORTS = ["NFL", "CFB", "MLB", "NBA", "CBB", "NHL", "OTH"];

interface GroupRow {
  id: string;
  name: string;
  status: "lobby" | "active" | "ended";
  invite_code: string;
  sports: string[];
  member_count: number;
  is_commissioner: boolean;
}
interface Member {
  user_id: string;
  display_name: string;
  color_index: number;
  home_state?: string | null;
  home_completed?: boolean;
  is_bot?: boolean;
}
interface Territory {
  id: string;
  name: string;
  region: string;
  adjacent: string[];
  owner_id: string | null;
  hold_level: number;
  contested: boolean;
}
interface Attack {
  id: string;
  territory_id: string;
  attacker_id: string;
  defender_id: string;
  status: string;
  defense_deadline: string;
  tier: number;
}
interface ScoreRow {
  user_id: string;
  display_name: string;
  color_index: number;
  cumulative_score: number;
  state_count: number;
}
interface FeedRow {
  id: string;
  message: string;
  created_at: string;
  territory_id?: string | null;
}
interface Snapshot {
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
interface Question {
  attempt_id: string;
  text: string;
  format: "multiple_choice" | "free_fill";
  options: string[];
  tier: number;
  sport: string;
  link_type: string;
  expires_at: string;
}
interface ActiveOperation {
  session_id: string;
  action_type: string;
  territory_id: string;
  required_correct: number;
  correct_count: number;
  question: Question;
}
interface ResultState {
  ok: boolean;
  title: string;
  message: string;
  correctAnswer?: string | null;
}
interface ToastState { text: string; error?: boolean }

type View = "map" | "standings" | "feed";

function memberColor(member?: Pick<Member, "color_index"> | Pick<ScoreRow, "color_index"> | null) {
  return PLAYER_COLORS[member?.color_index ?? 0] ?? PLAYER_COLORS[0];
}

export default function TerritoryGameV2() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [operation, setOperation] = useState<ActiveOperation | null>(null);
  const [result, setResult] = useState<ResultState | null>(null);
  const [view, setView] = useState<View>("map");
  const [selected, setSelected] = useState<string | null>(null);
  const [front, setFront] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [leaguePicker, setLeaguePicker] = useState(false);

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const loadGroups = useCallback(async (preferred?: string | null) => {
    const { data, error } = await supabase.rpc("get_my_groups");
    if (error) {
      notify(error.message, true);
      return;
    }
    const rows = (data ?? []) as GroupRow[];
    setGroups(rows);
    const saved = window.localStorage.getItem("territory_group");
    const next = preferred ?? saved ?? rows.find((row) => row.status === "active")?.id ?? rows[0]?.id ?? null;
    setGroupId(next);
    if (next) window.localStorage.setItem("territory_group", next);
  }, [notify]);

  const loadSnapshot = useCallback(async (target?: string | null) => {
    const id = target ?? groupId;
    if (!id) {
      setSnapshot(null);
      return;
    }
    const [snapshotResponse, operationResponse] = await Promise.all([
      supabase.rpc("group_snapshot", { p_group_id: id }),
      supabase.rpc("get_my_active_session", { p_group_id: id }),
    ]);
    if (snapshotResponse.error) {
      notify(snapshotResponse.error.message, true);
      return;
    }
    setSnapshot(snapshotResponse.data as Snapshot);
    if (operationResponse.data) setOperation(operationResponse.data as ActiveOperation);
  }, [groupId, notify]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setAuthReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setGroups([]);
      setGroupId(null);
      setSnapshot(null);
      return;
    }
    loadGroups();
  }, [session, loadGroups]);

  useEffect(() => {
    if (session && groupId) loadSnapshot(groupId);
  }, [session, groupId, loadSnapshot]);

  useEffect(() => {
    const seasonId = snapshot?.season?.id;
    if (!seasonId) return;
    const refresh = () => loadSnapshot(groupId);
    const channel = supabase.channel(`territory-v2-${seasonId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "season_territories", filter: `season_id=eq.${seasonId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "attacks", filter: `season_id=eq.${seasonId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "activity_events", filter: `season_id=eq.${seasonId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "player_actions", filter: `season_id=eq.${seasonId}` }, refresh)
      .subscribe();
    const polling = window.setInterval(refresh, 20_000);
    return () => {
      window.clearInterval(polling);
      supabase.removeChannel(channel);
    };
  }, [snapshot?.season?.id, groupId, loadSnapshot]);

  async function beginAction(kind: string, state: string, attackId?: string) {
    if (!snapshot?.season) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("game_begin_action", {
      p_season_id: snapshot.season.id,
      p_territory_id: state,
      p_action_type: kind,
      p_attack_id: attackId ?? null,
    });
    setBusy(false);
    if (error) {
      notify(error.message, true);
      return;
    }
    setOperation(data as ActiveOperation);
  }

  if (!authReady) return <Loading label="Loading the battlefield" />;
  if (!session) return <AuthStage notify={notify} />;
  if (!groupId || groups.length === 0) {
    return <LeagueEntry user={session.user} onCreated={(id) => loadGroups(id)} notify={notify} />;
  }
  if (!snapshot) return <Loading label="Syncing the map" />;
  if (operation || result) {
    return (
      <QuestionArena
        operation={operation}
        result={result}
        setOperation={setOperation}
        setResult={setResult}
        refresh={() => loadSnapshot()}
        notify={notify}
      />
    );
  }

  const me = snapshot.members.find((member) => member.user_id === snapshot.current_user_id);
  if (snapshot.group.status === "lobby" || !snapshot.season) {
    return (
      <LobbyStage
        snapshot={snapshot}
        groups={groups}
        groupId={groupId}
        setGroupId={setGroupId}
        refresh={() => loadSnapshot()}
        reloadGroups={() => loadGroups()}
        notify={notify}
      />
    );
  }

  return (
    <main className={styles.app}>
      {toast && <div className={`${styles.toast} ${toast.error ? styles.toastError : ""}`}>{toast.text}</div>}
      {leaguePicker && (
        <LeaguePicker
          groups={groups}
          active={groupId}
          onPick={(id) => {
            setGroupId(id);
            window.localStorage.setItem("territory_group", id);
            setLeaguePicker(false);
            setSelected(null);
            setFront(null);
            setView("map");
          }}
          onClose={() => setLeaguePicker(false)}
        />
      )}
      <GameShell
        snapshot={snapshot}
        me={me}
        view={view}
        setView={setView}
        selected={selected}
        setSelected={setSelected}
        front={front}
        setFront={setFront}
        busy={busy}
        beginAction={beginAction}
        openLeagues={() => setLeaguePicker(true)}
        refill={async () => {
          setBusy(true);
          const { error } = await supabase.rpc("test_refill_actions", { p_group_id: snapshot.group.id });
          setBusy(false);
          if (error) notify(error.message, true);
          else {
            notify("Three playtest actions restored.");
            loadSnapshot();
          }
        }}
      />
    </main>
  );
}

function Loading({ label }: { label: string }) {
  return <main className={styles.loading}><div className={styles.loadingOrb} /><span>{label}</span></main>;
}

function AuthStage({ notify }: { notify: (text: string, error?: boolean) => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setBusy(false);
      if (error) notify(error.message, true);
      return;
    }

    const { data, error } = await supabase.functions.invoke("test-signup", {
      body: { displayName, email, password, inviteCode },
    });
    if (error) {
      setBusy(false);
      notify(await edgeErrorMessage(error), true);
      return;
    }
    const payload = data as { ok?: boolean; error?: string; message?: string };
    if (!payload.ok) {
      setBusy(false);
      notify(payload.error ?? "Account creation failed.", true);
      return;
    }
    const signIn = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (signIn.error) {
      notify(`Account created, but sign-in failed: ${signIn.error.message}`, true);
      return;
    }
    notify(payload.message ?? "Account created and joined.");
  }

  return (
    <main className={styles.authPage}>
      <div className={styles.authBackdrop} aria-hidden="true">
        <svg viewBox="0 0 1030 620">
          {Object.entries(PATHS).map(([code, path]) => (
            <path key={code} d={path} fill={code === "TX" ? "#E34A34" : "rgba(255,255,255,.08)"} stroke="rgba(255,255,255,.13)" strokeWidth="1" />
          ))}
        </svg>
      </div>
      <section className={styles.authHero}>
        <div className={styles.logoMark}>T</div>
        <div className={styles.kicker}>SPORTS TRIVIA · TERRITORY WAR</div>
        <h1>Know the game.<br />Own the map.</h1>
        <p>Claim states, defend borders and settle which friend actually knows sports.</p>
      </section>
      <section className={styles.authPanel}>
        <div className={styles.segmented}>
          <button className={mode === "signin" ? styles.segmentActive : ""} onClick={() => setMode("signin")}>Sign in</button>
          <button className={mode === "signup" ? styles.segmentActive : ""} onClick={() => setMode("signup")}>Join playtest</button>
        </div>
        <form onSubmit={submit} className={styles.form}>
          {mode === "signup" && (
            <>
              <label><span>Display name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="nickname" required /></label>
              <label><span>League invite code</span><input value={inviteCode} onChange={(event) => setInviteCode(event.target.value.toUpperCase())} maxLength={8} placeholder="9BCDF13C" required /></label>
            </>
          )}
          <label><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
          <label><span>Password</span><input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} required /></label>
          {mode === "signup" && <div className={styles.confirmNote}><strong>No confirmation email.</strong> A valid playtest code creates a confirmed account and joins the league immediately.</div>}
          <button className={styles.primaryButton} disabled={busy}>{busy ? "Working…" : mode === "signin" ? "Enter the map" : "Create account and join"}</button>
        </form>
      </section>
    </main>
  );
}

function LeagueEntry({ user, onCreated, notify }: { user: User; onCreated: (id: string) => void; notify: (text: string, error?: boolean) => void }) {
  const [tab, setTab] = useState<"join" | "create">("join");
  const [code, setCode] = useState("");
  const [name, setName] = useState("The Bench Mob");
  const [sports, setSports] = useState<string[]>(SPORTS);
  const [busy, setBusy] = useState(false);

  async function join() {
    setBusy(true);
    const { data, error } = await supabase.rpc("join_group", { p_invite_code: code.trim().toUpperCase() });
    setBusy(false);
    if (error) notify(error.message, true);
    else onCreated(data as string);
  }
  async function create() {
    setBusy(true);
    const { data, error } = await supabase.rpc("create_group_v2", {
      p_name: name,
      p_sports: sports,
      p_season_length: 14,
      p_opening_mode: "open",
      p_board_scope: "fifty",
      p_difficulty: "standard",
      p_test_mode: true,
    });
    setBusy(false);
    if (error) notify(error.message, true);
    else onCreated(data as string);
  }

  return (
    <main className={styles.entryPage}>
      <section className={styles.entryPanel}>
        <div className={styles.logoLine}><div className={styles.logoMarkSmall}>T</div><strong>Territory</strong></div>
        <span className={styles.muted}>{user.email}</span>
        <h1>Choose your battlefield.</h1>
        <div className={styles.segmented}>
          <button className={tab === "join" ? styles.segmentActive : ""} onClick={() => setTab("join")}>Join league</button>
          <button className={tab === "create" ? styles.segmentActive : ""} onClick={() => setTab("create")}>Create league</button>
        </div>
        {tab === "join" ? (
          <div className={styles.form}>
            <label><span>Invite code</span><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={8} placeholder="9BCDF13C" /></label>
            <button className={styles.primaryButton} disabled={busy || code.length !== 8} onClick={join}>Join this map</button>
          </div>
        ) : (
          <div className={styles.form}>
            <label><span>League name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <div className={styles.sportGrid}>{SPORTS.map((sport) => <button key={sport} className={sports.includes(sport) ? styles.sportActive : ""} onClick={() => setSports(sports.includes(sport) ? sports.filter((item) => item !== sport) : [...sports, sport])}>{sport}</button>)}</div>
            <button className={styles.primaryButton} disabled={busy || name.trim().length < 2 || !sports.length} onClick={create}>Create league</button>
          </div>
        )}
        <button className={styles.textButton} onClick={() => supabase.auth.signOut()}>Sign out</button>
      </section>
    </main>
  );
}

function LobbyStage({ snapshot, groups, groupId, setGroupId, refresh, reloadGroups, notify }: {
  snapshot: Snapshot;
  groups: GroupRow[];
  groupId: string;
  setGroupId: (id: string) => void;
  refresh: () => void;
  reloadGroups: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const me = snapshot.members.find((member) => member.user_id === snapshot.current_user_id);
  const commissioner = snapshot.group.commissioner_id === snapshot.current_user_id;
  const [homeState, setHomeState] = useState(me?.home_state ?? "");
  const [busy, setBusy] = useState(false);
  const used = new Set(snapshot.members.map((member) => member.home_state).filter(Boolean) as string[]);
  const humans = snapshot.members.filter((member) => !member.is_bot);
  const homesReady = humans.every((member) => member.home_state);

  async function saveHome() {
    setBusy(true);
    const { error } = await supabase.rpc("set_home_state", { p_group_id: snapshot.group.id, p_home_state: homeState });
    setBusy(false);
    if (error) notify(error.message, true);
    else {
      notify(`${STATE_NAMES[homeState]} is your home ground.`);
      refresh();
    }
  }
  async function start() {
    setBusy(true);
    const { error } = await supabase.rpc("start_season", { p_group_id: snapshot.group.id });
    setBusy(false);
    if (error) notify(error.message, true);
    else {
      notify("Season started.");
      refresh();
      reloadGroups();
    }
  }

  return (
    <main className={styles.lobbyPage}>
      <div className={styles.lobbyMap}>
        <TerritoryMap territories={[]} members={snapshot.members} currentUser={snapshot.current_user_id} selected={homeState || null} onSelect={(code) => { if (!used.has(code) || me?.home_state === code) setHomeState(code); }} front={null} previewHome={homeState} />
      </div>
      <section className={styles.lobbySheet}>
        <div className={styles.lobbyHeader}>
          <div><span className={styles.kicker}>LEAGUE LOBBY</span><h1>{snapshot.group.name}</h1></div>
          <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
        </div>
        <div className={styles.inviteStrip}><span>Invite code</span><strong>{snapshot.group.invite_code}</strong><button onClick={async () => { await navigator.clipboard.writeText(snapshot.group.invite_code); notify("Invite code copied."); }}>Copy</button></div>
        <div className={styles.lobbyBody}>
          <div className={styles.homeChoice}>
            <div><span className={styles.kicker}>YOUR HOME GROUND</span><h2>{homeState ? STATE_NAMES[homeState] : "Choose a state"}</h2><p>Tap the map or use the list. Your opening question determines its first garrison.</p></div>
            <select value={homeState} onChange={(event) => setHomeState(event.target.value)}><option value="">Choose state</option>{ALL_STATES.map((code) => <option key={code} value={code} disabled={used.has(code) && me?.home_state !== code}>{STATE_NAMES[code]}</option>)}</select>
            <button className={styles.primaryButton} disabled={!homeState || busy} onClick={saveHome}>{me?.home_state ? "Update home state" : "Lock home state"}</button>
          </div>
          <div className={styles.playerRail}>{snapshot.members.map((member) => <div key={member.user_id} className={styles.playerAvatar}><span style={{ background: memberColor(member) }}>{member.display_name.slice(0, 1).toUpperCase()}</span><strong>{member.display_name}</strong><small>{member.is_bot ? "Bot" : member.home_state ?? "Choosing"}</small></div>)}</div>
          {commissioner && <button className={styles.startButton} disabled={busy || humans.length < 2 || !homesReady} onClick={start}>{!homesReady ? "Waiting for home states" : humans.length < 2 ? "Two people required" : "Start the season"}</button>}
          <button className={styles.textButton} onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </section>
    </main>
  );
}

function GameShell({ snapshot, me, view, setView, selected, setSelected, front, setFront, busy, beginAction, openLeagues, refill }: {
  snapshot: Snapshot;
  me?: Member;
  view: View;
  setView: (view: View) => void;
  selected: string | null;
  setSelected: (state: string | null) => void;
  front: string | null;
  setFront: (userId: string | null) => void;
  busy: boolean;
  beginAction: (kind: string, state: string, attackId?: string) => void;
  openLeagues: () => void;
  refill: () => void;
}) {
  const memberMap = useMemo(() => Object.fromEntries(snapshot.members.map((member) => [member.user_id, member])), [snapshot.members]);
  const territoryMap = useMemo(() => Object.fromEntries(snapshot.territories.map((territory) => [territory.id, territory])), [snapshot.territories]);
  const myStates = snapshot.territories.filter((territory) => territory.owner_id === snapshot.current_user_id);
  const legalTargets = useMemo(() => {
    if (!myStates.length) return new Set(snapshot.territories.map((territory) => territory.id));
    const targets = new Set<string>();
    myStates.forEach((territory) => (territory.adjacent?.length ? territory.adjacent : ADJ[territory.id] ?? []).forEach((neighbor) => targets.add(neighbor)));
    return targets;
  }, [myStates, snapshot.territories]);
  const selectedTerritory = selected ? territoryMap[selected] : null;
  const selectedOwner = selectedTerritory?.owner_id ? memberMap[selectedTerritory.owner_id] : null;
  const pendingDefense = snapshot.attacks.find((attack) => attack.defender_id === snapshot.current_user_id && attack.status === "contested");
  const homePending = me?.home_state && !me.home_completed;
  const myScore = snapshot.scores.find((score) => score.user_id === snapshot.current_user_id)?.cumulative_score ?? 0;
  const rivals = snapshot.members.filter((member) => member.user_id !== snapshot.current_user_id && snapshot.territories.some((territory) => territory.owner_id === member.user_id && (territory.adjacent ?? ADJ[territory.id] ?? []).some((neighbor) => territoryMap[neighbor]?.owner_id === snapshot.current_user_id)));

  let action: null | { kind: string; label: string; danger?: boolean } = null;
  if (selectedTerritory) {
    if (selectedTerritory.owner_id === snapshot.current_user_id && selectedTerritory.hold_level < 3 && !selectedTerritory.contested) action = { kind: "fortify", label: `Fortify to garrison ${selectedTerritory.hold_level + 1}` };
    else if (selectedTerritory.owner_id === null) action = { kind: "claim", label: "Claim · one Tier 1 question" };
    else if (selectedTerritory.owner_id !== snapshot.current_user_id) action = { kind: "attack", label: `Attack · ${selectedTerritory.hold_level === 1 ? 2 : 3} correct in a row`, danger: true };
  }
  const canTarget = Boolean(selectedTerritory && legalTargets.has(selectedTerritory.id) && !selectedTerritory.contested);

  return (
    <>
      <header className={styles.gameHeader}>
        <button className={styles.brandButton} onClick={openLeagues}><span className={styles.logoMarkSmall}>T</span><div><strong>Territory</strong><small>{snapshot.group.name}</small></div></button>
        <div className={styles.profilePill}><span style={{ background: memberColor(me) }}>{me?.display_name.slice(0, 1).toUpperCase()}</span><div><strong>{me?.display_name}</strong><small>Day {dayNumber(snapshot.season)}</small></div></div>
      </header>

      {view === "map" && (
        <section className={styles.board}>
          <div className={styles.mapGlow} />
          <TerritoryMap territories={snapshot.territories} members={snapshot.members} currentUser={snapshot.current_user_id} selected={selected} onSelect={(state) => { setSelected(state); setFront(null); }} front={front} />
          <div className={styles.hud}>
            <HudMetric value={snapshot.actions_remaining} label="Actions" danger={snapshot.actions_remaining === 0} />
            <HudMetric value={myStates.length} label="States" />
            <HudMetric value={myScore} label="Points" />
          </div>
          {rivals.length > 0 && <div className={styles.frontRail}><button className={!front ? styles.frontActive : ""} onClick={() => setFront(null)}>All</button>{rivals.map((rival) => <button key={rival.user_id} className={front === rival.user_id ? styles.frontActive : ""} onClick={() => { setFront(rival.user_id); setSelected(null); }}><span style={{ background: memberColor(rival) }} />{rival.display_name}</button>)}</div>}
          {!selectedTerritory && (
            <MissionDock
              snapshot={snapshot}
              me={me}
              defense={pendingDefense}
              homePending={Boolean(homePending)}
              busy={busy}
              beginAction={beginAction}
              refill={refill}
            />
          )}
          {selectedTerritory && (
            <TerritorySheet
              territory={selectedTerritory}
              owner={selectedOwner}
              currentUser={snapshot.current_user_id}
              homeState={me?.home_state ?? null}
              action={action}
              canTarget={canTarget}
              actionsRemaining={snapshot.actions_remaining}
              busy={busy}
              onClose={() => setSelected(null)}
              onAction={() => action && beginAction(action.kind, selectedTerritory.id)}
            />
          )}
        </section>
      )}
      {view === "standings" && <StandingsOverlay snapshot={snapshot} />}
      {view === "feed" && <FeedOverlay snapshot={snapshot} />}
      <nav className={styles.bottomNav}>
        <button className={view === "map" ? styles.navActive : ""} onClick={() => setView("map")}><span>⌖</span>Map</button>
        <button className={view === "standings" ? styles.navActive : ""} onClick={() => setView("standings")}><span>▥</span>Standings</button>
        <button className={view === "feed" ? styles.navActive : ""} onClick={() => setView("feed")}><span>◌</span>Activity</button>
      </nav>
    </>
  );
}

function TerritoryMap({ territories, members, currentUser, selected, onSelect, front, previewHome }: {
  territories: Territory[];
  members: Member[];
  currentUser: string;
  selected: string | null;
  onSelect: (state: string) => void;
  front: string | null;
  previewHome?: string;
}) {
  const territoryMap = Object.fromEntries(territories.map((territory) => [territory.id, territory]));
  const memberMap = Object.fromEntries(members.map((member) => [member.user_id, member]));
  const visible = (state: string) => {
    if (!front) return true;
    const ownerId = territoryMap[state]?.owner_id;
    return ownerId === currentUser || ownerId === front;
  };
  const onFront = (state: string) => {
    if (!front) return false;
    const ownerId = territoryMap[state]?.owner_id;
    return (ownerId === currentUser && (ADJ[state] ?? []).some((neighbor) => territoryMap[neighbor]?.owner_id === front)) ||
      (ownerId === front && (ADJ[state] ?? []).some((neighbor) => territoryMap[neighbor]?.owner_id === currentUser));
  };
  const fill = (state: string) => {
    if (previewHome === state) return DANGER;
    const ownerId = territoryMap[state]?.owner_id;
    return ownerId ? memberColor(memberMap[ownerId]) : NEUTRAL;
  };

  return (
    <svg className={styles.mapSvg} viewBox="0 0 1030 620" role="img" aria-label="United States territory map">
      <defs>
        <filter id="state-shadow" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#0d1a2a" floodOpacity=".22" /></filter>
        <pattern id="garrison-hatch" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="8" stroke="rgba(255,255,255,.7)" strokeWidth="2" /></pattern>
      </defs>
      {Object.keys(PATHS).map((state) => (
        <path
          key={state}
          d={PATHS[state]}
          className={styles.statePath}
          fill={fill(state)}
          stroke="rgba(255,255,255,.92)"
          strokeWidth="1.6"
          opacity={visible(state) ? 1 : 0.16}
          filter={selected === state ? "url(#state-shadow)" : undefined}
          onClick={() => onSelect(state)}
        />
      ))}
      {territories.filter((territory) => territory.hold_level === 3 && visible(territory.id)).map((territory) => <path key={`${territory.id}-hatch`} d={PATHS[territory.id]} fill="url(#garrison-hatch)" pointerEvents="none" />)}
      {front && territories.filter((territory) => onFront(territory.id)).map((territory) => <path key={`${territory.id}-front`} d={PATHS[territory.id]} fill="none" stroke={INK} strokeWidth="3.2" pointerEvents="none" />)}
      {selected && <path d={PATHS[selected]} fill="none" stroke={DANGER} strokeWidth="4.5" pointerEvents="none" />}
      {MAP_LABELS.map((state) => CENTROIDS[state] && <text key={`${state}-label`} x={CENTROIDS[state][0]} y={CENTROIDS[state][1] + 6} textAnchor="middle" className={styles.stateLabel} fill={territoryMap[state]?.owner_id || previewHome === state ? "white" : "rgba(20,32,52,.46)"} opacity={visible(state) ? 1 : .16}>{state}</text>)}
      {Object.entries(LEADERS).map(([state, y]) => CENTROIDS[state] && <g key={`${state}-leader`} opacity={visible(state) ? 1 : .16} pointerEvents="none"><line x1={CENTROIDS[state][0]} y1={CENTROIDS[state][1]} x2="966" y2={y} stroke={INK} strokeWidth=".8" opacity=".36" /><text x="974" y={y + 6} className={styles.stateLabel} fill={INK}>{state}</text></g>)}
    </svg>
  );
}

function HudMetric({ value, label, danger }: { value: number; label: string; danger?: boolean }) {
  return <div className={styles.hudMetric}><strong className={danger ? styles.dangerText : ""}>{value}</strong><span>{label}</span></div>;
}

function MissionDock({ snapshot, me, defense, homePending, busy, beginAction, refill }: {
  snapshot: Snapshot;
  me?: Member;
  defense?: Attack;
  homePending: boolean;
  busy: boolean;
  beginAction: (kind: string, state: string, attackId?: string) => void;
  refill: () => void;
}) {
  if (defense) {
    return <div className={`${styles.missionDock} ${styles.missionDanger}`}><div><span>UNDER ATTACK · {timeLeft(defense.defense_deadline)}</span><h2>Defend {STATE_NAMES[defense.territory_id]}</h2><p>One answer decides who owns it.</p></div><button disabled={busy} onClick={() => beginAction("defend", defense.territory_id, defense.id)}>Defend now</button></div>;
  }
  if (homePending && me?.home_state) {
    return <div className={styles.missionDock}><div><span>OPENING MOVE</span><h2>Secure {STATE_NAMES[me.home_state]}</h2><p>Answer once to raise your starting garrison.</p></div><button disabled={busy} onClick={() => beginAction("home", me.home_state!)}>Play question</button></div>;
  }
  if (snapshot.actions_remaining === 0) {
    return <div className={styles.missionDock}><div><span>ACTIONS SPENT</span><h2>Hold the line</h2><p>Claiming, attacking and fortifying all spend a move. More arrive at the daily refresh.</p></div>{snapshot.group.test_mode && <button disabled={busy} onClick={refill}>Refill test actions</button>}</div>;
  }
  return <div className={styles.missionDock}><div><span>YOUR MOVE</span><h2>Choose a border state</h2><p>Tap a neighboring state to claim or attack.</p></div><div className={styles.actionCount}>{snapshot.actions_remaining}<small>left</small></div></div>;
}

function TerritorySheet({ territory, owner, currentUser, homeState, action, canTarget, actionsRemaining, busy, onClose, onAction }: {
  territory: Territory;
  owner?: Member | null;
  currentUser: string;
  homeState: string | null;
  action: null | { kind: string; label: string; danger?: boolean };
  canTarget: boolean;
  actionsRemaining: number;
  busy: boolean;
  onClose: () => void;
  onAction: () => void;
}) {
  const mine = territory.owner_id === currentUser;
  const disabled = busy || Boolean(action && isTerritoryActionBlocked({
    kind: action.kind,
    contested: territory.contested,
    sharesBorder: canTarget,
    actionsRemaining,
  }));
  return (
    <aside className={styles.territorySheet}>
      <button className={styles.sheetHandle} onClick={onClose} aria-label="Close territory details" />
      <div className={styles.sheetTitle}><div><span>{territory.region}</span><h2>{STATE_NAMES[territory.id]}</h2></div><div className={styles.stateCode}>{territory.id}</div></div>
      <div className={styles.ownerRow}><span style={{ background: owner ? memberColor(owner) : NEUTRAL }} /><strong>{owner ? mine ? "Your territory" : owner.display_name : "Unclaimed"}</strong><small>Garrison {territory.hold_level}{homeState === territory.id ? " · Home" : ""}</small></div>
      <p className={styles.sheetReason}>{territory.contested ? "An attack is already active here." : mine ? "Fortify once per day — it spends a move — to increase the cost of stealing it." : canTarget ? "This state touches your border." : "You do not share a border with this state."}</p>
      {action && <button className={`${styles.sheetAction} ${action.danger ? styles.sheetActionDanger : ""}`} disabled={disabled} onClick={onAction}>{action.label}</button>}
    </aside>
  );
}

function StandingsOverlay({ snapshot }: { snapshot: Snapshot }) {
  const ranked = [...snapshot.scores].sort((a, b) => b.cumulative_score - a.cumulative_score || b.state_count - a.state_count);
  return <section className={styles.overlayPage}><div className={styles.overlayHeading}><span>DAY {dayNumber(snapshot.season)}</span><h1>Standings</h1><p>Points reward holding ground every day, not a final-hour land grab.</p></div><div className={styles.rankingList}>{ranked.map((player, index) => <div key={player.user_id} className={styles.rankingRow}><div className={styles.rankNumber}>{index + 1}</div><span className={styles.rankingAvatar} style={{ background: memberColor(player) }}>{player.display_name.slice(0, 1)}</span><div><strong>{player.display_name}{player.user_id === snapshot.current_user_id ? " · You" : ""}</strong><small>{player.state_count} states</small></div><b>{player.cumulative_score}</b></div>)}</div></section>;
}
function FeedOverlay({ snapshot }: { snapshot: Snapshot }) {
  return <section className={styles.overlayPage}><div className={styles.overlayHeading}><span>LIVE LEAGUE</span><h1>Activity</h1><p>Every claim, attack and defense writes the story of the board.</p></div><div className={styles.feedList}>{snapshot.activity.length ? snapshot.activity.map((event) => <div key={event.id} className={styles.feedItem}><span>{event.territory_id ?? "•"}</span><div><strong>{event.message}</strong><small>{new Date(event.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></div></div>) : <p className={styles.empty}>The map is quiet. The first correct answer changes that.</p>}</div></section>;
}

function LeaguePicker({ groups, active, onPick, onClose }: { groups: GroupRow[]; active: string; onPick: (id: string) => void; onClose: () => void }) {
  return <div className={styles.modalScrim} onClick={onClose}><section className={styles.leagueModal} onClick={(event) => event.stopPropagation()}><div className={styles.modalHeader}><h2>Your leagues</h2><button onClick={onClose}>×</button></div>{groups.map((group) => <button key={group.id} className={`${styles.leagueOption} ${group.id === active ? styles.leagueOptionActive : ""}`} onClick={() => onPick(group.id)}><div><strong>{group.name}</strong><small>{group.member_count} players · {group.status}</small></div><span>{group.invite_code}</span></button>)}</section></div>;
}

function QuestionArena({ operation, result, setOperation, setResult, refresh, notify }: {
  operation: ActiveOperation | null;
  result: ResultState | null;
  setOperation: (operation: ActiveOperation | null) => void;
  setResult: (result: ResultState | null) => void;
  refresh: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const timedOut = useRef(false);
  const question = operation?.question;

  useEffect(() => {
    setAnswer("");
    timedOut.current = false;
  }, [question?.attempt_id]);
  useEffect(() => {
    if (!question) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((new Date(question.expires_at).getTime() - Date.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0 && !timedOut.current && !busy) {
        timedOut.current = true;
        void submit("");
      }
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [question?.attempt_id, busy]);

  async function submit(value = answer) {
    if (!operation || busy) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("game_submit_answer", { p_session_id: operation.session_id, p_answer: value });
    setBusy(false);
    if (error) {
      notify(error.message, true);
      return;
    }
    if (data.status === "active" && data.question) {
      setOperation({ ...operation, question: data.question, correct_count: data.correct_count });
      setAnswer("");
      return;
    }
    const ok = data.status !== "failed";
    setOperation(null);
    setResult({
      ok,
      title: ok ? data.status === "contested" ? "Challenge issued" : "Territory secured" : "Operation failed",
      message: data.message ?? (ok ? "The map changed." : "The map did not move."),
      correctAnswer: data.correct_answer ?? null,
    });
  }

  if (result) {
    return <main className={`${styles.resultPage} ${result.ok ? styles.resultSuccess : styles.resultFailure}`}><div className={styles.resultHalo} /><section><span>{result.ok ? "SUCCESS" : "FAILED"}</span><h1>{result.title}</h1><p>{result.message}</p>{result.correctAnswer && <small>Correct answer: {result.correctAnswer}</small>}<button onClick={() => { setResult(null); refresh(); }}>Return to map</button></section></main>;
  }
  if (!operation || !question) return <Loading label="Restoring question" />;
  const operationLabel = operation.action_type === "home" ? "HOME GROUND" : operation.action_type === "claim" ? "CLAIM" : operation.action_type === "attack" ? "ATTACK" : operation.action_type === "defend" ? "DEFENSE" : "FORTIFY";

  return <main className={styles.questionPage}><div className={styles.questionState}>{operation.territory_id}</div><header><div><span>{operationLabel} · TIER {question.tier}</span><strong>{STATE_NAMES[operation.territory_id]}</strong></div><div className={`${styles.timer} ${seconds <= 8 ? styles.timerDanger : ""}`}>0:{String(seconds).padStart(2, "0")}</div></header><section className={styles.questionCard}><div className={styles.streak}>{Array.from({ length: operation.required_correct }, (_, index) => <span key={index} className={index < operation.correct_count ? styles.streakDone : ""} />)}</div><h1>{question.text}</h1>{question.format === "multiple_choice" ? <div className={styles.answerGrid}>{(question.options ?? []).map((option) => <button key={option} className={answer === option ? styles.answerSelected : ""} onClick={() => setAnswer(option)}>{option}</button>)}</div> : <input className={styles.freeAnswer} autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} placeholder="Type your answer" />}<button className={styles.lockButton} disabled={busy || !answer} onClick={() => submit()}>{busy ? "Checking…" : "Lock answer"}</button></section></main>;
}

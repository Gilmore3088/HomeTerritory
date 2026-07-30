"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, type Session, type User } from "@supabase/supabase-js";
import mapData from "@/data/us-states.json";
import adjacencyData from "@/data/adjacency.json";
import regionData from "@/data/regions.json";

const SUPABASE_URL = "https://gduvdnpxgdniogmxxlmg.supabase.co";
const SUPABASE_KEY = "sb_publishable_Xgxcnh4NUlZ7dkYHeC-xiw_mOmxQxGZ";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const PAPER = "#F2EFE4";
const INK = "#12140F";
const NEUTRAL = "#D3CCB8";
const HOT = "#C8371D";
const PLAYER_COLORS = ["#1F4E79", "#6B3FA0", "#2E7D4F", "#C88A1E", "#A33B3B", "#1E7A82", "#8C4A2F", "#4B647A"];
const PATHS = mapData.paths as Record<string, string>;
const CENTROIDS = mapData.centroids as Record<string, [number, number]>;
const ADJ = adjacencyData.adjacency as Record<string, string[]>;
const REGIONS = regionData.regions as Record<string, string[]>;

const STATE_NAMES: Record<string, string> = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",
  HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",
  MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",
  NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",
  SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",
};
const ALL_STATES = Object.keys(STATE_NAMES).sort((a,b)=>STATE_NAMES[a].localeCompare(STATE_NAMES[b]));
const BIG_LABELS = ALL_STATES.filter((s)=>!["CT","DE","MA","MD","NH","NJ","RI","VT","WV"].includes(s));
const LEADERS: Record<string, number> = { VT:132, NH:158, MA:184, RI:210, CT:236, NJ:262, DE:288, MD:314, WV:340 };

const SPORTS = [
  ["NFL", "NFL"], ["CFB", "College football"], ["MLB", "MLB"], ["NBA", "NBA"], ["CBB", "College basketball"], ["NHL", "NHL"], ["OTH", "Other"],
] as const;

type GroupRow = {
  id: string; name: string; status: "lobby"|"active"|"ended"; invite_code: string; sports: string[]; member_count: number; is_commissioner: boolean;
};
type Member = { user_id: string; display_name: string; color_index: number; home_state?: string|null; home_completed?: boolean; is_bot?: boolean };
type Territory = { id: string; name: string; region: string; adjacent: string[]; owner_id: string|null; hold_level: number; contested: boolean };
type Attack = { id: string; territory_id: string; attacker_id: string; defender_id: string; status: string; defense_deadline: string; tier: number };
type ScoreRow = { user_id: string; display_name: string; color_index: number; cumulative_score: number; state_count: number };
type FeedRow = { id: string; message: string; created_at: string; territory_id?: string|null };
type Snapshot = {
  current_user_id: string;
  group: { id:string; name:string; commissioner_id:string; invite_code:string; sports:string[]; status:string; test_mode?:boolean; opening_mode?:string; difficulty?:string; board_scope?:string };
  season: null | { id:string; status:string; started_at:string; ends_at:string; current_day?:number };
  members: Member[];
  territories: Territory[];
  attacks: Attack[];
  scores: ScoreRow[];
  activity: FeedRow[];
  actions_remaining: number;
};
type Question = { attempt_id:string; text:string; format:"multiple_choice"|"free_fill"; options:string[]; tier:number; sport:string; link_type:string; expires_at:string };
type ActiveOperation = { session_id:string; action_type:string; territory_id:string; required_correct:number; correct_count:number; question:Question };
type ResultState = { ok:boolean; title:string; message:string; correctAnswer?:string|null };
type Toast = { text:string; error?:boolean } | null;

function colorForMember(m?: Member | ScoreRow | null) { return PLAYER_COLORS[m?.color_index ?? 0] ?? PLAYER_COLORS[0]; }
function regionFor(code:string) { return Object.entries(REGIONS).find(([,list])=>list.includes(code))?.[0] ?? ""; }
function dayFromSeason(season:Snapshot["season"]) {
  if (!season) return 0;
  if (season.current_day) return season.current_day;
  return Math.max(1, Math.floor((Date.now() - new Date(season.started_at).getTime()) / 86400000) + 1);
}
function formatDeadline(value:string) {
  const ms = new Date(value).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function TerritoryApp() {
  const [session, setSession] = useState<Session|null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [groupId, setGroupId] = useState<string|null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot|null>(null);
  const [activeOp, setActiveOp] = useState<ActiveOperation|null>(null);
  const [result, setResult] = useState<ResultState|null>(null);
  const [view, setView] = useState<"map"|"standings"|"feed">("map");
  const [selected, setSelected] = useState<string|null>(null);
  const [front, setFront] = useState<string|null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [showGroups, setShowGroups] = useState(false);

  const notify = useCallback((text:string, error=false)=>{
    setToast({text,error});
    window.setTimeout(()=>setToast(null), 3800);
  },[]);

  const loadGroups = useCallback(async (preferred?:string|null) => {
    const { data, error } = await supabase.rpc("get_my_groups");
    if (error) { notify(error.message, true); return; }
    const rows = (data ?? []) as GroupRow[];
    setGroups(rows);
    const stored = typeof window !== "undefined" ? window.localStorage.getItem("territory_group") : null;
    const next = preferred ?? groupId ?? stored ?? rows.find(g=>g.status==="active")?.id ?? rows[0]?.id ?? null;
    setGroupId(next);
    if (next) window.localStorage.setItem("territory_group", next);
  },[groupId, notify]);

  const loadSnapshot = useCallback(async (target?:string|null) => {
    const id = target ?? groupId;
    if (!id) { setSnapshot(null); return; }
    const [{data,error},{data:operation,error:opError}] = await Promise.all([
      supabase.rpc("group_snapshot", { p_group_id:id }),
      supabase.rpc("get_my_active_session", { p_group_id:id }),
    ]);
    if (error) { notify(error.message, true); return; }
    if (opError && !opError.message.includes("Could not find")) console.warn(opError.message);
    setSnapshot(data as Snapshot);
    if (operation) setActiveOp(operation as ActiveOperation);
  },[groupId, notify]);

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{ setSession(data.session); setAuthReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_event,next)=>{ setSession(next); setAuthReady(true); });
    return ()=>data.subscription.unsubscribe();
  },[]);

  useEffect(()=>{
    if (!session) { setGroups([]); setGroupId(null); setSnapshot(null); return; }
    loadGroups();
  },[session]);

  useEffect(()=>{ if (session && groupId) loadSnapshot(groupId); },[session,groupId,loadSnapshot]);

  useEffect(()=>{
    const seasonId = snapshot?.season?.id;
    if (!seasonId) return;
    const refresh = ()=>loadSnapshot(groupId);
    const channel = supabase.channel(`territory-${seasonId}`)
      .on("postgres_changes", {event:"*", schema:"public", table:"season_territories", filter:`season_id=eq.${seasonId}`}, refresh)
      .on("postgres_changes", {event:"*", schema:"public", table:"attacks", filter:`season_id=eq.${seasonId}`}, refresh)
      .on("postgres_changes", {event:"*", schema:"public", table:"activity_events", filter:`season_id=eq.${seasonId}`}, refresh)
      .on("postgres_changes", {event:"*", schema:"public", table:"player_actions", filter:`season_id=eq.${seasonId}`}, refresh)
      .subscribe();
    const poll = window.setInterval(refresh, 20000);
    return ()=>{ window.clearInterval(poll); supabase.removeChannel(channel); };
  },[snapshot?.season?.id, groupId, loadSnapshot]);

  if (!authReady) return <div className="loading">Opening the atlas</div>;
  if (!session) return <AuthScreen notify={notify}/>;
  if (!groupId || groups.length===0) return <NoGroup user={session.user} onCreated={(id)=>loadGroups(id)} notify={notify}/>;
  if (!snapshot) return <div className="loading">Reading the board</div>;
  if (activeOp || result) return <QuestionFlow operation={activeOp} result={result} setOperation={setActiveOp} setResult={setResult} refresh={()=>loadSnapshot()} notify={notify}/>;

  const currentMember = snapshot.members.find(m=>m.user_id===snapshot.current_user_id);
  if (snapshot.group.status === "lobby" || !snapshot.season) {
    return <Lobby snapshot={snapshot} groups={groups} groupId={groupId} setGroupId={setGroupId} refresh={()=>loadSnapshot()} reloadGroups={()=>loadGroups()} notify={notify}/>;
  }

  return (
    <div className="shell">
      {toast && <div className={`toast ${toast.error?"error":""}`}>{toast.text}</div>}
      {showGroups && <GroupSwitcher groups={groups} active={groupId} onPick={(id)=>{setGroupId(id);setShowGroups(false);}} onClose={()=>setShowGroups(false)}/>} 
      {view === "map" && <MapView snapshot={snapshot} me={currentMember} selected={selected} setSelected={setSelected} front={front} setFront={setFront}
        begin={(kind,state,attackId)=>beginAction(snapshot.season!.id,kind,state,attackId,setBusy,setActiveOp,notify)} busy={busy}
        refill={async()=>{setBusy(true);const {error}=await supabase.rpc("test_refill_actions",{p_group_id:snapshot.group.id});setBusy(false);if(error)notify(error.message,true);else{notify("Test actions refilled.");loadSnapshot();}}}
        openGroups={()=>setShowGroups(true)} />}
      {view === "standings" && <StandingsView snapshot={snapshot} openGroups={()=>setShowGroups(true)}/>} 
      {view === "feed" && <FeedView snapshot={snapshot} openGroups={()=>setShowGroups(true)}/>} 
      <nav className="nav">
        <button className={view==="map"?"active":""} onClick={()=>setView("map")}>Map</button>
        <button className={view==="standings"?"active":""} onClick={()=>setView("standings")}>Standings</button>
        <button className={view==="feed"?"active":""} onClick={()=>setView("feed")}>Dispatches</button>
      </nav>
    </div>
  );
}

async function beginAction(seasonId:string,kind:string,state:string,attackId:string|undefined,setBusy:(v:boolean)=>void,setOp:(v:ActiveOperation|null)=>void,notify:(t:string,e?:boolean)=>void) {
  setBusy(true);
  const {data,error} = await supabase.rpc("game_begin_action", {
    p_season_id: seasonId,
    p_territory_id: state,
    p_action_type: kind,
    p_attack_id: attackId ?? null,
  });
  setBusy(false);
  if (error) { notify(error.message,true); return; }
  setOp(data as ActiveOperation);
}

function AuthScreen({notify}:{notify:(t:string,e?:boolean)=>void}) {
  const [mode,setMode]=useState<"signin"|"signup">("signin");
  const [name,setName]=useState("");
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [busy,setBusy]=useState(false);
  async function submit(e:FormEvent){
    e.preventDefault(); setBusy(true);
    const response = mode==="signin"
      ? await supabase.auth.signInWithPassword({email,password})
      : await supabase.auth.signUp({email,password,options:{data:{display_name:name.trim()||email.split("@")[0]},emailRedirectTo:window.location.origin}});
    setBusy(false);
    if(response.error){notify(response.error.message,true);return;}
    if(mode==="signup"&&!response.data.session){notify("Account created. Open the confirmation email, then return here to sign in.");setMode("signin");}
  }
  return <main className="shell"><div className="screen">
    <div className="brand-lockup">
      <div className="eyebrow">A private sports trivia war</div>
      <h1>TERRITORY</h1>
      <p>Answer the question. Take the state. Make a friend defend it.</p>
    </div>
    <div className="card">
      <div className="eyebrow">{mode==="signin"?"Return to the map":"Take a seat"}</div>
      <form onSubmit={submit}>
        {mode==="signup"&&<div className="field"><label>Display name</label><input className="input" value={name} onChange={e=>setName(e.target.value)} required/></div>}
        <div className="field"><label>Email</label><input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></div>
        <div className="field"><label>Password</label><input className="input" type="password" minLength={8} value={password} onChange={e=>setPassword(e.target.value)} required/></div>
        <div style={{marginTop:16}}><button className="btn" disabled={busy}>{busy?"Working":""}{!busy&&(mode==="signin"?"Enter Territory":"Create account")}</button></div>
      </form>
      <button className="btn ghost" style={{marginTop:8}} onClick={()=>setMode(mode==="signin"?"signup":"signin")}>{mode==="signin"?"New player · create account":"Already seated · sign in"}</button>
    </div>
  </div></main>;
}

function NoGroup({user,onCreated,notify}:{user:User;onCreated:(id:string)=>void;notify:(t:string,e?:boolean)=>void}) {
  const [tab,setTab]=useState<"join"|"create">("join");
  const [code,setCode]=useState("");
  const [name,setName]=useState("The Bench Mob");
  const [sports,setSports]=useState<string[]>(["NFL","CFB","MLB","NBA","CBB","NHL","OTH"]);
  const [busy,setBusy]=useState(false);
  async function join(){setBusy(true);const {data,error}=await supabase.rpc("join_group",{p_invite_code:code.trim().toUpperCase()});setBusy(false);if(error)notify(error.message,true);else onCreated(data as string);}
  async function create(){setBusy(true);const {data,error}=await supabase.rpc("create_group_v2",{p_name:name,p_sports:sports,p_season_length:14,p_opening_mode:"open",p_board_scope:"fifty",p_difficulty:"standard",p_test_mode:true});setBusy(false);if(error)notify(error.message,true);else onCreated(data as string);}
  return <main className="shell"><div className="screen">
    <div className="eyebrow">Territory · {user.email}</div><h1 className="display" style={{fontSize:48,margin:"8px 0 6px"}}>Find your map.</h1><p className="muted">Join a friend or commission a private season.</p>
    <div className="row" style={{margin:"22px 0 14px"}}><button className={`btn ${tab==="join"?"":"ghost"}`} onClick={()=>setTab("join")}>Join</button><button className={`btn ${tab==="create"?"":"ghost"}`} onClick={()=>setTab("create")}>Create</button></div>
    {tab==="join"?<div className="card"><div className="eyebrow">Invite code</div><div className="field"><input className="input" value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="ABCDE" maxLength={8}/></div><button className="btn" style={{marginTop:13}} disabled={busy||code.length<5} onClick={join}>Join the league</button></div>
    :<div className="card"><div className="eyebrow">New private league</div><div className="field"><label>League name</label><input className="input" value={name} onChange={e=>setName(e.target.value)}/></div><div className="field"><label>Sports</label><div className="scroller">{SPORTS.map(([id,label])=><button type="button" key={id} className={`front-pill ${sports.includes(id)?"active":""}`} onClick={()=>setSports(sports.includes(id)?sports.filter(s=>s!==id):[...sports,id])}>{label}</button>)}</div></div><button className="btn" style={{marginTop:13}} disabled={busy||name.trim().length<2||!sports.length} onClick={create}>Open the lobby</button></div>}
  </div></main>;
}

function GroupSwitcher({groups,active,onPick,onClose}:{groups:GroupRow[];active:string;onPick:(id:string)=>void;onClose:()=>void}) {
  return <div style={{position:"fixed",inset:0,zIndex:60,background:"rgba(18,20,15,.38)",display:"flex",alignItems:"flex-end"}} onClick={onClose}>
    <div style={{width:"min(480px,100%)",margin:"0 auto",background:PAPER,borderTop:`1.5px solid ${INK}`,padding:"20px 18px max(30px,env(safe-area-inset-bottom))"}} onClick={e=>e.stopPropagation()}>
      <div className="section-rule" style={{marginTop:0}}><span className="number">LEAGUES</span><h2>Choose a map</h2></div>
      {groups.map(g=><button key={g.id} className={`card ${g.id===active?"hot":""}`} style={{width:"100%",textAlign:"left",marginBottom:8,cursor:"pointer"}} onClick={()=>onPick(g.id)}><div className="split"><strong>{g.name}</strong><span className="eyebrow">{g.status}</span></div><div className="leader-detail">{g.member_count} players · {g.invite_code}</div></button>)}
      <button className="btn ghost" onClick={onClose}>Close</button>
    </div>
  </div>;
}

function Lobby({snapshot,groups,groupId,setGroupId,refresh,reloadGroups,notify}:{snapshot:Snapshot;groups:GroupRow[];groupId:string;setGroupId:(id:string)=>void;refresh:()=>void;reloadGroups:()=>void;notify:(t:string,e?:boolean)=>void}) {
  const me=snapshot.members.find(m=>m.user_id===snapshot.current_user_id);
  const commissioner=snapshot.group.commissioner_id===snapshot.current_user_id;
  const [home,setHome]=useState(me?.home_state??"");
  const [busy,setBusy]=useState(false);
  const used = new Set(snapshot.members.map(m=>m.home_state).filter(Boolean) as string[]);
  async function saveHome(){setBusy(true);const {error}=await supabase.rpc("set_home_state",{p_group_id:snapshot.group.id,p_home_state:home});setBusy(false);if(error)notify(error.message,true);else{notify(`${STATE_NAMES[home]} is your home ground.`);refresh();}}
  async function start(){setBusy(true);const {error}=await supabase.rpc("start_season",{p_group_id:snapshot.group.id});setBusy(false);if(error)notify(error.message,true);else{notify("The board is set.");refresh();reloadGroups();}}
  const humans=snapshot.members.filter(m=>!m.is_bot);
  const homesReady=humans.every(m=>m.home_state);
  return <main className="shell"><div className="screen">
    <div className="split"><div><div className="eyebrow">Private league · lobby</div><h1 className="display" style={{fontSize:46,margin:"7px 0 0"}}>{snapshot.group.name}</h1></div><button className="btn ghost small" onClick={()=>setGroupId(groups.find(g=>g.id!==groupId)?.id??groupId)}>Maps</button></div>
    <div className="card hot" style={{marginTop:20}}><div className="eyebrow">Invite code</div><div style={{fontFamily:"var(--mono)",fontSize:34,letterSpacing:".12em",marginTop:8}}>{snapshot.group.invite_code}</div><button className="btn ghost" style={{marginTop:13}} onClick={async()=>{await navigator.clipboard.writeText(snapshot.group.invite_code);notify("Invite code copied.");}}>Copy the code</button></div>
    <div className="section-rule"><span className="number">01</span><h2>Choose home ground</h2></div>
    <div className="card"><p className="muted" style={{marginTop:0}}>You own this state before the first whistle. Your opening question decides whether it starts exposed or dug in.</p><div className="field"><label>Your home state</label><select className="select" value={home} onChange={e=>setHome(e.target.value)}><option value="">Pick a state</option>{ALL_STATES.map(s=><option key={s} value={s} disabled={used.has(s)&&me?.home_state!==s}>{STATE_NAMES[s]}</option>)}</select></div><button className="btn" style={{marginTop:13}} disabled={!home||busy} onClick={saveHome}>{me?.home_state?"Change home ground":"Claim home ground"}</button></div>
    <div className="section-rule"><span className="number">02</span><h2>The table</h2></div>
    <div className="card">{snapshot.members.map(m=><div className="member-row" key={m.user_id}><span className="player-chip" style={{background:colorForMember(m)}}/><div className="grow"><div className="leader-name">{m.display_name}{m.user_id===snapshot.current_user_id?" · you":""}</div><div className="leader-detail">{m.is_bot?"test bot":m.home_state?`${STATE_NAMES[m.home_state]} home ground`:"still choosing home ground"}</div></div><span className="eyebrow">{m.is_bot?"BOT":m.home_state??"—"}</span></div>)}</div>
    {commissioner&&<><div className="section-rule"><span className="number">03</span><h2>Set the board loose</h2></div><div className="card"><div className="leader-detail">{snapshot.group.opening_mode==="dealt"?"Dealt board · every state owned on day one":"Open board · home states only"} · {snapshot.group.difficulty??"standard"} difficulty</div><button className="btn hot" style={{marginTop:13}} disabled={busy||humans.length<2||!homesReady} onClick={start}>{!homesReady?`${humans.filter(m=>!m.home_state).length} player${humans.filter(m=>!m.home_state).length===1?"":"s"} still need home ground`:humans.length<2?"Two people are required":"Start the season"}</button></div></>}
    <button className="btn ghost" style={{marginTop:18}} onClick={()=>supabase.auth.signOut()}>Sign out</button>
  </div></main>;
}

function MapView({snapshot,me,selected,setSelected,front,setFront,begin,busy,refill,openGroups}:{snapshot:Snapshot;me?:Member;selected:string|null;setSelected:(s:string|null)=>void;front:string|null;setFront:(s:string|null)=>void;begin:(k:string,s:string,a?:string)=>void;busy:boolean;refill:()=>void;openGroups:()=>void}) {
  const memberMap=useMemo(()=>Object.fromEntries(snapshot.members.map(m=>[m.user_id,m])),[snapshot.members]);
  const territoryMap=useMemo(()=>Object.fromEntries(snapshot.territories.map(t=>[t.id,t])),[snapshot.territories]);
  const myStates=snapshot.territories.filter(t=>t.owner_id===snapshot.current_user_id);
  const legal=useMemo(()=>{
    if(myStates.length===0)return new Set(snapshot.territories.map(t=>t.id));
    const set=new Set<string>();
    for(const t of myStates) for(const n of (t.adjacent?.length?t.adjacent:ADJ[t.id]??[])) set.add(n);
    return set;
  },[myStates,snapshot.territories]);
  const selectedTerritory=selected?territoryMap[selected]:null;
  const owner=selectedTerritory?.owner_id?memberMap[selectedTerritory.owner_id]:null;
  const pendingDefense=snapshot.attacks.find(a=>a.defender_id===snapshot.current_user_id&&a.status==="contested");
  const homePending=me?.home_state&&!me.home_completed;
  const day=dayFromSeason(snapshot.season);
  const myScore=snapshot.scores.find(s=>s.user_id===snapshot.current_user_id)?.cumulative_score??0;
  const rivals=snapshot.members.filter(m=>m.user_id!==snapshot.current_user_id&&snapshot.territories.some(t=>t.owner_id===m.user_id&&(t.adjacent??ADJ[t.id]??[]).some(n=>territoryMap[n]?.owner_id===snapshot.current_user_id)));
  const canTarget=selectedTerritory&&legal.has(selectedTerritory.id)&&!selectedTerritory.contested;
  let action:null|{kind:string;label:string;hot?:boolean;attackId?:string}=null;
  if(selectedTerritory){
    if(selectedTerritory.owner_id===snapshot.current_user_id&&selectedTerritory.hold_level<3&&!selectedTerritory.contested) action={kind:"fortify",label:`Dig in to ${selectedTerritory.hold_level+1} · free`};
    else if(selectedTerritory.owner_id===null) action={kind:"claim",label:"Claim · one question, Tier 1"};
    else if(selectedTerritory.owner_id!==snapshot.current_user_id) action={kind:"attack",label:`Attack · ${selectedTerritory.hold_level===1?2:3} in a row, Tier ${selectedTerritory.hold_level===3?3:2}`,hot:true};
  }
  return <>
    <header className="app-head"><div className="split"><div className="identity"><span className="player-chip" style={{background:colorForMember(me)}}/><span className="player-name">{me?.display_name??"Player"}</span></div><button className="btn ghost small" onClick={openGroups}>{snapshot.group.name}</button></div>
      <div className="metric-row"><Metric value={snapshot.actions_remaining} label="actions left" hot={snapshot.actions_remaining===0}/><Metric value={myStates.length} label="states"/><Metric value={myScore} label="points"/><Metric value={day} label="day"/></div>
    </header>
    <div className="plate"><div className="plate-inner"><TerritoryMap territories={snapshot.territories} members={snapshot.members} currentUser={snapshot.current_user_id} selected={selected} onSelect={s=>{setSelected(s);setFront(null);}} front={front}/></div><div className="plate-caption"><span>{front?`Front · ${memberMap[front]?.display_name}`:"Your board"}</span><span>{myStates.length} of 50</span></div></div>

    <div className="priority-wrap">
      {pendingDefense?<div className="priority-card hot"><div className="eyebrow" style={{color:HOT}}>Under attack · {formatDeadline(pendingDefense.defense_deadline)} left</div><h2>Hold {STATE_NAMES[pendingDefense.territory_id]}.</h2><p>One answer decides whether the attack dies here or the state changes hands.</p><button className="btn hot" disabled={busy} onClick={()=>begin("defend",pendingDefense.territory_id,pendingDefense.id)}>Defend {STATE_NAMES[pendingDefense.territory_id]} · Tier {pendingDefense.tier}</button></div>
      :homePending?<div className="priority-card"><div className="eyebrow">Home ground</div><h2>{STATE_NAMES[me!.home_state!]} is yours.</h2><p>One Tier 2 question decides whether it starts exposed or dug in at garrison 2.</p><button className="btn" disabled={busy} onClick={()=>begin("home",me!.home_state!)}>Answer for {STATE_NAMES[me!.home_state!]}</button></div>
      :snapshot.actions_remaining===0?<div className="priority-card"><div className="eyebrow">Land grabs spent</div><h2>The run stops here.</h2><p>You can still fortify your own states for free. Attack actions replenish on the next daily reset.</p>{snapshot.group.test_mode&&<button className="btn ghost" disabled={busy} onClick={refill}>Testing · refill three actions</button>}</div>
      :<div className="priority-card"><div className="eyebrow">Your move</div><h2>Choose a border.</h2><p>Tap a neutral or rival state touching your territory. The button will tell you exactly what the move costs.</p></div>}
    </div>

    {rivals.length>0&&<div className="fronts"><div className="eyebrow">Your fronts</div><div className="scroller">{rivals.map(r=><button key={r.user_id} className={`front-pill ${front===r.user_id?"active":""}`} onClick={()=>{setFront(front===r.user_id?null:r.user_id);setSelected(null);}}><span className="owner-dot" style={{background:colorForMember(r)}}/>{r.display_name}</button>)}</div></div>}

    {selectedTerritory?<div className="state-panel"><div className="split"><h3>{STATE_NAMES[selectedTerritory.id]}</h3><span className="eyebrow">{selectedTerritory.region||regionFor(selectedTerritory.id)}</span></div><div className="owner-line"><span className="owner-dot" style={{background:owner?colorForMember(owner):NEUTRAL}}/>{owner?(owner.user_id===snapshot.current_user_id?"Yours":owner.display_name):"Unclaimed"}{owner&&<span className="muted">· garrison {selectedTerritory.hold_level}</span>}{me?.home_state===selectedTerritory.id&&<span className="eyebrow">home</span>}</div><div className="state-meta">{selectedTerritory.contested?"Active attack · no second operation allowed":action?.kind==="fortify"?"One fortify attempt per territory each day":canTarget?"On your border · legal target":"No border with anything you hold"}</div>{action&&<button className={`btn ${action.hot?"hot":""}`} disabled={busy||selectedTerritory.contested||((action.kind==="claim"||action.kind==="attack")&&(!canTarget||snapshot.actions_remaining===0))} onClick={()=>begin(action!.kind,selectedTerritory.id)}>{action.label}</button>}<button className="btn ghost" onClick={()=>setSelected(null)}>Close state</button></div>
    :<div style={{padding:"13px 18px 0"}}><p className="muted" style={{fontSize:14,lineHeight:1.55}}>Tap a state to move on it. Hatched territory is fully dug in. Use a front to strip the map down to one rivalry.</p></div>}
  </>;
}

function TerritoryMap({territories,members,currentUser,selected,onSelect,front}:{territories:Territory[];members:Member[];currentUser:string;selected:string|null;onSelect:(s:string)=>void;front:string|null}) {
  const tMap=Object.fromEntries(territories.map(t=>[t.id,t]));
  const mMap=Object.fromEntries(members.map(m=>[m.user_id,m]));
  const involved=(s:string)=>{if(!front)return true;const o=tMap[s]?.owner_id;return o===currentUser||o===front;};
  const onLine=(s:string)=>{if(!front)return false;const o=tMap[s]?.owner_id;return (o===currentUser&&(ADJ[s]??[]).some(n=>tMap[n]?.owner_id===front))||(o===front&&(ADJ[s]??[]).some(n=>tMap[n]?.owner_id===currentUser));};
  const fill=(s:string)=>{const o=tMap[s]?.owner_id;return o?colorForMember(mMap[o]):NEUTRAL;};
  return <svg viewBox="0 0 1030 620" role="img" aria-label="United States territory map">
    <defs><pattern id="hatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="7" stroke={INK} strokeWidth="1.4" opacity=".32"/></pattern></defs>
    {Object.keys(PATHS).map(s=><path key={s} d={PATHS[s]} className="state-path" fill={fill(s)} stroke={PAPER} strokeWidth="1.2" strokeLinejoin="round" opacity={involved(s)?1:.14} onClick={()=>onSelect(s)}/>)}
    {territories.filter(t=>t.hold_level===3&&involved(t.id)).map(t=><path key={`${t.id}-h`} d={PATHS[t.id]} fill="url(#hatch)" pointerEvents="none"/>)}
    {front&&territories.filter(t=>onLine(t.id)).map(t=><path key={`${t.id}-f`} d={PATHS[t.id]} fill="none" stroke={INK} strokeWidth="2.4" pointerEvents="none"/>)}
    {selected&&<path d={PATHS[selected]} fill="none" stroke={INK} strokeWidth="3.2" pointerEvents="none"/>}
    {BIG_LABELS.map(s=>CENTROIDS[s]&&<text key={`${s}-label`} x={CENTROIDS[s][0]} y={CENTROIDS[s][1]+7} textAnchor="middle" className="state-label" fill={tMap[s]?.owner_id?"rgba(255,255,255,.94)":"rgba(18,20,15,.42)"} opacity={involved(s)?1:.14}>{s}</text>)}
    {Object.entries(LEADERS).map(([s,y])=>CENTROIDS[s]&&<g key={`${s}-lead`} opacity={involved(s)?1:.14} pointerEvents="none"><line x1={CENTROIDS[s][0]} y1={CENTROIDS[s][1]} x2="966" y2={y} stroke={INK} strokeWidth=".7" opacity=".4"/><circle cx={CENTROIDS[s][0]} cy={CENTROIDS[s][1]} r="2.2" fill={INK} opacity=".55"/><text x="972" y={y+7} className="state-label" fill={INK}>{s}</text></g>)}
  </svg>;
}

function Metric({value,label,hot=false}:{value:string|number;label:string;hot?:boolean}) {return <div><div className="metric-value" style={{color:hot?HOT:INK}}>{value}</div><div className="metric-label">{label}</div></div>}

function StandingsView({snapshot,openGroups}:{snapshot:Snapshot;openGroups:()=>void}) {
  const ranked=[...snapshot.scores].sort((a,b)=>b.cumulative_score-a.cumulative_score||b.state_count-a.state_count);
  return <div className="screen"><div className="split"><div><div className="eyebrow">{snapshot.group.name} · day {dayFromSeason(snapshot.season)}</div><h1 className="display" style={{fontSize:46,margin:"6px 0 0"}}>The count.</h1></div><button className="btn ghost small" onClick={openGroups}>Leagues</button></div><div className="section-rule"><span className="number">01</span><h2>Cumulative score</h2></div><div className="card">{ranked.map((p,i)=><div className="leader-row" key={p.user_id}><div className="rank">{i+1}</div><span className="player-chip" style={{background:colorForMember(p)}}/><div className="grow"><div className="leader-name">{p.display_name}{p.user_id===snapshot.current_user_id?" · you":""}</div><div className="leader-detail">{p.state_count} states standing</div></div><div className="score">{p.cumulative_score}</div></div>)}</div><div className="section-rule"><span className="number">02</span><h2>How points land</h2></div><div className="card soft"><p style={{margin:0,lineHeight:1.6}}><strong>+1</strong> per state each day. <strong>+1</strong> more for every state dug in at garrison 3. <strong>+5</strong> for a full region. The season rewards holding land, not one final-day raid.</p></div></div>;
}

function FeedView({snapshot,openGroups}:{snapshot:Snapshot;openGroups:()=>void}) {
  return <div className="screen"><div className="split"><div><div className="eyebrow">{snapshot.group.name} · field reports</div><h1 className="display" style={{fontSize:46,margin:"6px 0 0"}}>Dispatches.</h1></div><button className="btn ghost small" onClick={openGroups}>Leagues</button></div><div className="section-rule"><span className="number">01</span><h2>What changed</h2></div><div className="card">{snapshot.activity.length?snapshot.activity.map((item)=><div className="feed-row" key={item.id}><div className="feed-day">{item.territory_id??"·"}</div><div className="grow"><div className="feed-copy">{item.message}</div><div className="leader-detail">{new Date(item.created_at).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</div></div></div>):<div className="empty">No blood on the map yet. The first correct answer writes the first dispatch.</div>}</div></div>;
}

function QuestionFlow({operation,result,setOperation,setResult,refresh,notify}:{operation:ActiveOperation|null;result:ResultState|null;setOperation:(o:ActiveOperation|null)=>void;setResult:(r:ResultState|null)=>void;refresh:()=>void;notify:(t:string,e?:boolean)=>void}) {
  const [answer,setAnswer]=useState("");
  const [busy,setBusy]=useState(false);
  const [seconds,setSeconds]=useState(0);
  const timedOut=useRef(false);
  const question=operation?.question;
  useEffect(()=>{setAnswer("");timedOut.current=false;},[question?.attempt_id]);
  useEffect(()=>{
    if(!question)return;
    const tick=()=>{
      const left=Math.max(0,Math.ceil((new Date(question.expires_at).getTime()-Date.now())/1000));setSeconds(left);
      if(left===0&&!timedOut.current&&!busy){timedOut.current=true;submit("");}
    };
    tick();const id=window.setInterval(tick,250);return()=>window.clearInterval(id);
  },[question?.attempt_id,busy]);
  async function submit(value=answer){
    if(!operation||busy)return;setBusy(true);
    const {data,error}=await supabase.rpc("game_submit_answer",{p_session_id:operation.session_id,p_answer:value});setBusy(false);
    if(error){notify(error.message,true);return;}
    if(data.status==="active"&&data.question){setOperation({...operation,question:data.question,correct_count:data.correct_count});setAnswer("");return;}
    const ok=data.status!=="failed";
    setOperation(null);setResult({ok,title:ok?(data.status==="contested"?"The challenge stands.":"The map moves."):"The run dies here.",message:data.message??(ok?"Correct.":"Incorrect."),correctAnswer:data.correct_answer??null});
  }
  if(result)return <main className="shell"><div className="question-screen"><div className={`result-card ${result.ok?"correct":"failed"}`}><div className="result-mark">{result.ok?"Operation resolved":"Operation lost"}</div><h2>{result.title}</h2><p>{result.message}</p>{result.correctAnswer&&<p><strong>Answer:</strong> {result.correctAnswer}</p>}</div><button className="btn" onClick={()=>{setResult(null);refresh();}}>Return to the map</button></div></main>;
  if(!operation||!question)return <div className="loading">Restoring the operation</div>;
  const label=operation.action_type==="home"?"Home ground":operation.action_type==="claim"?"Claiming":operation.action_type==="attack"?"Attacking":operation.action_type==="defend"?"Defending":"Digging in";
  return <main className="shell"><div className="question-screen">
    <div className="question-top"><div className="eyebrow">{label} · Tier {question.tier}</div><div className={`clock ${seconds<=8?"hot":""}`}>0:{String(seconds).padStart(2,"0")}</div></div>
    <div className="question-body"><div className="question-state">{STATE_NAMES[operation.territory_id]}</div><h1 className="question-prompt">{question.text}</h1>
      {question.format==="multiple_choice"?<div className="answers">{(question.options??[]).map(option=><button key={option} className={`answer-option ${answer===option?"selected":""}`} onClick={()=>setAnswer(option)}>{option}</button>)}</div>
      :<div className="field"><label>Your answer</label><input className="input" autoFocus value={answer} onChange={e=>setAnswer(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")submit();}} placeholder="Type the name"/></div>}
      <div className="run-progress">{Array.from({length:operation.required_correct},(_,i)=><span key={i} className={`run-dot ${i<operation.correct_count?"done":""}`}/>)}</div>
    </div>
    <button className={`btn ${operation.action_type==="attack"||operation.action_type==="defend"?"hot":""}`} disabled={busy||!answer} onClick={()=>submit()}>{busy?"Grading":"Lock answer"}</button>
    <button className="btn ghost" onClick={()=>notify("The question is still live. Submit an answer or let the timer expire.",true)}>Leave question</button>
  </div></main>;
}

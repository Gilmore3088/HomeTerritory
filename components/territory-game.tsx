"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { useGameState } from "@/hooks/use-game-state";
import type { View } from "@/lib/game-types";
import styles from "./territory-game-v2.module.css";
import AuthStage from "./auth-stage";
import LeagueEntry from "./league-entry";
import LobbyStage from "./lobby-stage";
import GameShell from "./game-shell";
import QuestionArena from "./question-arena";
import { LeaguePicker, Loading } from "./game-overlays";

const supabase = createClient();

export default function TerritoryGame() {
  const { session, authReady } = useSupabaseSession();
  const {
    groups,
    groupId,
    setGroupId,
    snapshot,
    operation,
    setOperation,
    result,
    setResult,
    busy,
    setBusy,
    toast,
    notify,
    loadGroups,
    loadSnapshot,
    beginAction,
  } = useGameState(session);
  const [view, setView] = useState<View>("map");
  const [selected, setSelected] = useState<string | null>(null);
  const [front, setFront] = useState<string | null>(null);
  const [leaguePicker, setLeaguePicker] = useState(false);

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

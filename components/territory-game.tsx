"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useGameData } from "@/hooks/game-data-context";
import type { View } from "@/lib/game-types";
import styles from "./territory-game-v2.module.css";
import AuthStage from "./auth-stage";
import LeagueEntry from "./league-entry";
import LobbyStage from "./lobby-stage";
import GameShell from "./game-shell";
import QuestionArena from "./question-arena";
import { LeaguePicker, Loading, LoadErrorScreen, SeasonComplete } from "./game-overlays";

const supabase = createClient();

export default function TerritoryGame() {
  const {
    session,
    authReady,
    groups,
    groupId,
    selectGroup,
    snapshot,
    operation,
    setOperation,
    result,
    setResult,
    busy,
    setBusy,
    toast,
    notify,
    loadError,
    retryLoad,
    loadGroups,
    loadSnapshot,
    beginAction,
  } = useGameData();
  const [view, setView] = useState<View>("map");
  const [selected, setSelected] = useState<string | null>(null);
  const [front, setFront] = useState<string | null>(null);
  const [leaguePicker, setLeaguePicker] = useState(false);

  if (!authReady) return <Loading label="Loading the battlefield" />;
  if (!session) return <AuthStage notify={notify} />;
  // The error branch MUST precede the groups branch: a failed get_my_groups
  // for a returning player would otherwise render the first-run league screen
  // and invite a duplicate league.
  if (loadError) return <LoadErrorScreen error={loadError} onRetry={() => void retryLoad()} />;
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
      />
    );
  }

  const me = snapshot.members.find((member) => member.user_id === snapshot.current_user_id);
  // An ended season used to fall through to a frozen GameShell; it gets a
  // proper closing screen now.
  if (snapshot.season && snapshot.season.status !== "active") {
    return <SeasonComplete snapshot={snapshot} />;
  }
  if (snapshot.group.status === "lobby" || !snapshot.season) {
    return (
      <LobbyStage
        snapshot={snapshot}
        groups={groups}
        groupId={groupId}
        setGroupId={selectGroup}
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
            selectGroup(id);
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

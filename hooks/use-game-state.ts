"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { ActiveOperation, GroupRow, ResultState, Snapshot, ToastState } from "@/lib/game-types";
import { pickActiveGroup } from "@/lib/game-selection";
import { shouldClearOperation } from "@/lib/turn-reconcile";

const supabase = createClient();

export interface GameState {
  groups: GroupRow[];
  groupsReady: boolean;
  groupId: string | null;
  setGroupId: (id: string | null) => void;
  snapshot: Snapshot | null;
  operation: ActiveOperation | null;
  setOperation: (operation: ActiveOperation | null) => void;
  result: ResultState | null;
  setResult: (result: ResultState | null) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  toast: ToastState | null;
  notify: (text: string, error?: boolean) => void;
  loadGroups: (preferred?: string | null) => Promise<void>;
  loadSnapshot: (target?: string | null) => Promise<void>;
  beginAction: (kind: string, state: string, attackId?: string) => Promise<void>;
  advanceGroupDay: (days?: number) => Promise<void>;
}

export function useGameState(session: Session | null): GameState {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [groupsReady, setGroupsReady] = useState(false);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [operation, setOperation] = useState<ActiveOperation | null>(null);
  const [result, setResult] = useState<ResultState | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [signedIn, setSignedIn] = useState(Boolean(session));
  const beganAtRef = useRef<number | null>(null);

  // Dropping the signed-out player's board belongs to the sign-out transition
  // itself rather than to an effect: React re-renders with the cleared state
  // before anything paints, so signing in as someone else on the same page
  // never flashes the previous account's map.
  if (Boolean(session) !== signedIn) {
    setSignedIn(Boolean(session));
    if (!session) {
      setGroups([]);
      setGroupsReady(false);
      setGroupId(null);
      setSnapshot(null);
    }
  }

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const loadGroups = useCallback(async (preferred?: string | null) => {
    const { data, error } = await supabase.rpc("get_my_groups");
    if (error) {
      // The read still counts as settled: the caller shows the league-entry
      // screen with the error toast instead of an indefinite loading state.
      setGroupsReady(true);
      notify(error.message, true);
      return;
    }
    const rows = (data ?? []) as GroupRow[];
    setGroups(rows);
    setGroupsReady(true);
    const saved = window.localStorage.getItem("territory_group");
    const next = pickActiveGroup(rows, saved, preferred);
    setGroupId(next);
    if (next) window.localStorage.setItem("territory_group", next);
  }, [notify]);

  const loadSnapshot = useCallback(async (target?: string | null) => {
    const id = target ?? groupId;
    if (!id) {
      setSnapshot(null);
      return;
    }
    const loadStartedAtMs = Date.now();
    const [snapshotResponse, operationResponse] = await Promise.all([
      supabase.rpc("group_snapshot", { p_group_id: id }),
      supabase.rpc("get_my_active_session", { p_group_id: id }),
    ]);
    if (snapshotResponse.error) {
      notify(snapshotResponse.error.message, true);
      return;
    }
    setSnapshot(snapshotResponse.data as Snapshot);
    if (operationResponse.data) {
      setOperation(operationResponse.data as ActiveOperation);
    } else if (shouldClearOperation({
      serverHasSession: false,
      beganAtMs: beganAtRef.current,
      loadStartedAtMs,
    })) {
      setOperation(null);
    }
  }, [groupId, notify]);

  // Both loaders write state only once their RPC has resolved, so each read is
  // started from a local async function: that is what keeps the state writes in
  // a continuation instead of in the effect body itself.
  useEffect(() => {
    if (!session) return;
    async function readGroups() {
      await loadGroups();
    }
    void readGroups();
  }, [session, loadGroups]);

  useEffect(() => {
    if (!session || !groupId) return;
    async function readSnapshot() {
      await loadSnapshot(groupId);
    }
    void readSnapshot();
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

  // Tab refocus refresh (P2a kept only the 20s poll + realtime; a returning
  // tab waited up to 20s for fresh state). Throttled so a focus event and the
  // visibilitychange it usually arrives with trigger one read, not two.
  useEffect(() => {
    if (!session) return;
    let lastRefresh = 0;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastRefresh < 2000) return;
      lastRefresh = now;
      void loadGroups();
      if (groupId) void loadSnapshot(groupId);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [session, groupId, loadGroups, loadSnapshot]);

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
    beganAtRef.current = Date.now();
    setOperation(data as ActiveOperation);
  }

  async function advanceGroupDay(days = 1) {
    if (!snapshot) return;
    setBusy(true);
    const { error } = await supabase.rpc("advance_group_day", { p_group_id: snapshot.group.id, p_days: days });
    setBusy(false);
    if (error) notify(error.message, true);
    else {
      notify(days === 1 ? "The day advanced." : `Fast-forwarded ${days} days.`);
      loadSnapshot();
    }
  }

  return {
    groups,
    groupsReady,
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
    advanceGroupDay,
  };
}

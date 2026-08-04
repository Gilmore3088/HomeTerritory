"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { ActiveOperation, GameLoadError, GroupRow, ResultState, Snapshot, ToastState } from "@/lib/game-types";
import { pickActiveGroup } from "@/lib/game-selection";
import { shouldClearOperation } from "@/lib/turn-reconcile";
import { readSavedGroupId, writeSavedGroupId } from "@/lib/group-storage";
import { isStaleLoad, shouldShowLoadError } from "@/lib/snapshot-retry";

const supabase = createClient();

export interface GameState {
  groups: GroupRow[];
  groupId: string | null;
  selectGroup: (id: string) => void;
  snapshot: Snapshot | null;
  operation: ActiveOperation | null;
  setOperation: (operation: ActiveOperation | null) => void;
  result: ResultState | null;
  setResult: (result: ResultState | null) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  toast: ToastState | null;
  notify: (text: string, error?: boolean) => void;
  loadError: GameLoadError | null;
  retryLoad: () => Promise<void>;
  loadGroups: (preferred?: string | null) => Promise<void>;
  loadSnapshot: (target?: string | null) => Promise<void>;
  beginAction: (kind: string, state: string, attackId?: string) => Promise<void>;
  advanceGroupDay: () => Promise<void>;
}

// This hook is mounted inside the per-account subtree: GameDataProvider keys
// the provider that owns it on session.user.id, so an account switch unmounts
// the whole instance (state, refs, timers, channels, in-flight continuations)
// instead of relying on an enumerated wipe list. A token refresh keeps the
// same user id and therefore the same instance.
export function useGameState(session: Session | null): GameState {
  const userId = session?.user.id ?? null;
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [operation, setOperation] = useState<ActiveOperation | null>(null);
  const [result, setResult] = useState<ResultState | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [loadError, setLoadError] = useState<GameLoadError | null>(null);
  const beganAtRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  // Load generation: bumped on league switch so an in-flight response for the
  // previous league can never land on the new one.
  const generationRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const rerunRef = useRef(false);
  const failCountRef = useRef(0);
  const snapshotRef = useRef<Snapshot | null>(null);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const notify = useCallback((text: string, error = false) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast({ text, error });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const loadGroups = useCallback(async (preferred?: string | null) => {
    if (!userId) return;
    const { data, error } = await supabase.rpc("get_my_groups");
    if (error) {
      // A returning player must see a retryable error, never the first-run
      // league screen (creating a duplicate league is worse than waiting).
      setLoadError({ source: "groups", message: error.message });
      return;
    }
    setLoadError((current) => (current?.source === "groups" ? null : current));
    const rows = (data ?? []) as GroupRow[];
    setGroups(rows);
    const saved = readSavedGroupId(userId);
    const next = pickActiveGroup(rows, saved, preferred);
    setGroupId(next);
    if (next) writeSavedGroupId(userId, next);
  }, [userId]);

  const loadSnapshot = useCallback((target?: string | null): Promise<void> => {
    const id = target ?? groupId;
    if (!id) {
      setSnapshot(null);
      return Promise.resolve();
    }
    // Single-flight with a trailing rerun: callers arriving mid-flight share
    // the in-flight promise, and exactly one follow-up load runs afterwards so
    // a realtime event during the request is never silently swallowed.
    if (inFlightRef.current) {
      rerunRef.current = true;
      return inFlightRef.current;
    }
    const generation = generationRef.current;
    const run = (async () => {
      try {
        const loadStartedAtMs = Date.now();
        const [snapshotResponse, operationResponse] = await Promise.all([
          supabase.rpc("group_snapshot", { p_group_id: id }),
          supabase.rpc("get_my_active_session", { p_group_id: id }),
        ]);
        if (isStaleLoad(generation, generationRef.current)) return;
        if (snapshotResponse.error) {
          failCountRef.current += 1;
          if (shouldShowLoadError(failCountRef.current, snapshotRef.current !== null)) {
            setLoadError({ source: "snapshot", message: snapshotResponse.error.message });
          } else {
            notify(snapshotResponse.error.message, true);
          }
          return;
        }
        failCountRef.current = 0;
        setLoadError((current) => (current?.source === "snapshot" ? null : current));
        setSnapshot(snapshotResponse.data as Snapshot);
        if (operationResponse.error) {
          notify(operationResponse.error.message, true);
        } else if (operationResponse.data) {
          setOperation(operationResponse.data as ActiveOperation);
        } else if (shouldClearOperation({
          serverHasSession: false,
          beganAtMs: beganAtRef.current,
          loadStartedAtMs,
        })) {
          setOperation(null);
        }
      } finally {
        inFlightRef.current = null;
        if (rerunRef.current) {
          rerunRef.current = false;
          void loadSnapshotRef.current();
        }
      }
    })();
    inFlightRef.current = run;
    return run;
  }, [groupId, notify]);

  // The trailing rerun and the interval below must call the LATEST callback,
  // not the identity they closed over, so they reach it through a ref.
  const loadSnapshotRef = useRef(loadSnapshot);
  useEffect(() => {
    loadSnapshotRef.current = loadSnapshot;
  });

  const selectGroup = useCallback((id: string) => {
    generationRef.current += 1;
    failCountRef.current = 0;
    setLoadError(null);
    setGroupId(id);
    if (userId) writeSavedGroupId(userId, id);
  }, [userId]);

  const retryLoad = useCallback(async () => {
    setLoadError(null);
    failCountRef.current = 0;
    if (loadError?.source === "groups") await loadGroups();
    else await loadSnapshot();
  }, [loadError, loadGroups, loadSnapshot]);

  // Both loaders write state only once their RPC has resolved, so each read is
  // started from a local async function: that is what keeps the state writes in
  // a continuation instead of in the effect body itself. Effects key on the
  // user id, not the session object — a token refresh mints a new session
  // object every hour and must not re-run the loaders.
  useEffect(() => {
    if (!userId) return;
    async function readGroups() {
      await loadGroups();
    }
    void readGroups();
  }, [userId, loadGroups]);

  useEffect(() => {
    if (!userId || !groupId) return;
    async function readSnapshot() {
      await loadSnapshot(groupId);
    }
    void readSnapshot();
  }, [userId, groupId, loadSnapshot]);

  // The 20s poll is deliberately NOT gated on a snapshot existing: it is the
  // automatic recovery path when the first snapshot load fails.
  useEffect(() => {
    if (!userId || !groupId) return;
    const polling = window.setInterval(() => {
      void loadSnapshotRef.current();
    }, 20_000);
    return () => window.clearInterval(polling);
  }, [userId, groupId]);

  // Refresh on tab refocus (P2b task 10); focus and visibilitychange fire
  // together and the single-flight loader collapses the pair.
  useEffect(() => {
    if (!userId || !groupId) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadSnapshotRef.current();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId, groupId]);

  // Realtime stays gated on the season (its filters require season_id) and is
  // bootstrapped by the first successful snapshot; the poll covers the gap.
  useEffect(() => {
    const seasonId = snapshot?.season?.id;
    if (!seasonId || !userId) return;
    const refresh = () => {
      void loadSnapshotRef.current();
    };
    const channel = supabase.channel(`territory-v2-${userId}-${seasonId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "season_territories", filter: `season_id=eq.${seasonId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "attacks", filter: `season_id=eq.${seasonId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "activity_events", filter: `season_id=eq.${seasonId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "player_actions", filter: `season_id=eq.${seasonId}` }, refresh)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [snapshot?.season?.id, userId]);

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

  async function advanceGroupDay() {
    if (!snapshot) return;
    setBusy(true);
    const { error } = await supabase.rpc("advance_group_day", { p_group_id: snapshot.group.id });
    setBusy(false);
    if (error) notify(error.message, true);
    else {
      notify("The day advanced.");
      void loadSnapshot();
    }
  }

  return {
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
    advanceGroupDay,
  };
}

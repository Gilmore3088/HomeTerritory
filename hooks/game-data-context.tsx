"use client";

import { createContext, useContext } from "react";
import type { Session } from "@supabase/supabase-js";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { useGameState } from "@/hooks/use-game-state";

type GameData = { session: Session | null; authReady: boolean } & ReturnType<typeof useGameState>;

const GameDataContext = createContext<GameData | null>(null);

// The inner provider owns useGameState and is keyed on the account, so an
// account switch (including one broadcast from another tab) unmounts every
// piece of game state — hook state, refs, timers, realtime channels and
// in-flight RPC continuations — instead of trusting a wipe list to stay
// complete. A token refresh keeps the same user id, so a live question
// survives it. Both TerritoryGame and GameRuntimeControls render inside the
// keyed subtree.
export function GameDataProvider({ children }: { children: React.ReactNode }) {
  const { session, authReady } = useSupabaseSession();
  return (
    <GameStateScope key={session?.user.id ?? "anon"} session={session} authReady={authReady}>
      {children}
    </GameStateScope>
  );
}

function GameStateScope({ session, authReady, children }: {
  session: Session | null;
  authReady: boolean;
  children: React.ReactNode;
}) {
  const game = useGameState(session);
  return <GameDataContext.Provider value={{ session, authReady, ...game }}>{children}</GameDataContext.Provider>;
}

export function useGameData(): GameData {
  const ctx = useContext(GameDataContext);
  if (!ctx) throw new Error("useGameData must be used within GameDataProvider");
  return ctx;
}

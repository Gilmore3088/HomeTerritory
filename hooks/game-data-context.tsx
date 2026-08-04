"use client";

import { createContext, useContext } from "react";
import type { Session } from "@supabase/supabase-js";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { useGameState } from "@/hooks/use-game-state";

type GameData = { session: Session | null; authReady: boolean } & ReturnType<typeof useGameState>;

const GameDataContext = createContext<GameData | null>(null);

export function GameDataProvider({ children }: { children: React.ReactNode }) {
  const { session, authReady } = useSupabaseSession();
  const game = useGameState(session);
  return <GameDataContext.Provider value={{ session, authReady, ...game }}>{children}</GameDataContext.Provider>;
}

export function useGameData(): GameData {
  const ctx = useContext(GameDataContext);
  if (!ctx) throw new Error("useGameData must be used within GameDataProvider");
  return ctx;
}

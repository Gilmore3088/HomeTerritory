import GameRuntimeControls from "@/components/game-runtime-controls";
import TerritoryGame from "@/components/territory-game";
import { GameDataProvider } from "@/hooks/game-data-context";

export default function HomePage() {
  return (
    <GameDataProvider>
      <TerritoryGame />
      <GameRuntimeControls />
    </GameDataProvider>
  );
}

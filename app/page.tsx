import GameRuntimeControls from "@/components/game-runtime-controls";
import TerritoryGame from "@/components/territory-game";

export default function HomePage() {
  return (
    <>
      <TerritoryGame />
      <GameRuntimeControls />
    </>
  );
}

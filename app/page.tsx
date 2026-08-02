import GameRuntimeControls from "@/components/game-runtime-controls";
import TerritoryGameV2 from "@/components/territory-game-v2";

export default function HomePage() {
  return (
    <>
      <TerritoryGameV2 />
      <GameRuntimeControls />
    </>
  );
}

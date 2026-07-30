import EndTurnControl from "@/components/end-turn-control";
import LogoutControl from "@/components/logout-control";
import TerritoryGameV2 from "@/components/territory-game-v2";

export default function HomePage() {
  return (
    <>
      <TerritoryGameV2 />
      <EndTurnControl />
      <LogoutControl />
    </>
  );
}

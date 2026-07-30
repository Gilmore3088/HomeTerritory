import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/app-header";
import { GameClient } from "@/components/game-client";
import type { GameSnapshot } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function GamePage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data, error } = await supabase.rpc("group_snapshot", { p_group_id: groupId });
  if (error || !data) redirect("/app");
  const snapshot = data as GameSnapshot;

  return (
    <div className="site-shell">
      <AppHeader detail={snapshot.group.name} />
      <GameClient initialSnapshot={snapshot} />
    </div>
  );
}

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/app-header";
import { DashboardClient } from "@/components/dashboard-client";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase.rpc("get_my_groups");
  if (error) throw new Error(error.message);

  return (
    <div className="site-shell">
      <AppHeader detail={user.email ?? undefined} />
      <main className="page">
        <div className="page-heading">
          <div><div className="eyebrow">Your private leagues</div><h1>Pick your battlefield.</h1></div>
          <p className="subtle">The map is shared. Every answer changes the same game for everyone.</p>
        </div>
        <DashboardClient initialGroups={Array.isArray(data) ? data : []} />
      </main>
    </div>
  );
}

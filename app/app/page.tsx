import { redirect } from "next/navigation";

// Legacy card-grid dashboard, superseded by the map-first UI on "/".
// The old flow can no longer start seasons (home ground is required now),
// so this route is gated out. See docs/repo-audit-2026-07-30.md, finding 7.
export default function LegacyDashboardRedirect() {
  redirect("/");
}

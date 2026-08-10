import { redirect } from "next/navigation";

// Legacy per-group game page, superseded by the map-first UI on "/".
// See docs/repo-audit-2026-07-30.md, finding 7.
export default function LegacyGameRedirect() {
  redirect("/");
}

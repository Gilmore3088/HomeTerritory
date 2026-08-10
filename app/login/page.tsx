import { redirect } from "next/navigation";

// Legacy sign-in page; the map-first UI on "/" handles auth now.
// See docs/repo-audit-2026-07-30.md, finding 7.
export default function LegacyLoginRedirect() {
  redirect("/");
}

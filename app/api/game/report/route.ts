import { NextResponse } from "next/server";

// Legacy endpoint for the removed card-grid UI; the map-first UI on "/"
// calls the game RPCs directly. Gated out per docs/repo-audit-2026-07-30.md.
const gone = () => NextResponse.json({ error: "This endpoint has been retired. Use the app at /." }, { status: 410 });
export const GET = gone;
export const POST = gone;

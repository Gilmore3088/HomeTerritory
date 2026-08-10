import { NextResponse } from "next/server";

// Legacy endpoint for the removed card-grid UI. Its create_group v1 RPC has
// been revoked; the map-first UI calls create_group_v2 directly.
export async function POST() {
  return NextResponse.json({ error: "This endpoint has been retired. Use the app at /." }, { status: 410 });
}

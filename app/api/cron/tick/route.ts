import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

const EXPECTED_SCHEDULE = "5 8 * * *";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  const schedule = request.headers.get("x-vercel-cron-schedule");
  const cronSecret = process.env.CRON_SECRET;

  const hasConfiguredSecret = Boolean(cronSecret && authorization === `Bearer ${cronSecret}`);
  const isVercelScheduledRun = schedule === EXPECTED_SCHEDULE;

  if (!hasConfiguredSecret && !isVercelScheduledRun) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("run_daily_tick");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    schedule: schedule ?? null,
    result: data,
    ranAt: new Date().toISOString(),
  });
}

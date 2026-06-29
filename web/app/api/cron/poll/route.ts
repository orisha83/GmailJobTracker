import { NextRequest, NextResponse } from "next/server";
import { runPoll } from "@/lib/ingest/poll";
import { config } from "@/lib/config";

// googleapis needs the Node runtime (not edge); ingestion may take a while.
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Hourly ingestion entry point. Protected by CRON_SECRET so only the scheduler
 * (Vercel Cron) — or you, with the secret — can trigger it.
 *
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. For manual testing:
 *   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/poll
 */
export async function GET(request: NextRequest) {
  if (!config.cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${config.cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runPoll();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("Poll failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { runBackfill } from "@/lib/ingest/backfill";
import { config } from "@/lib/config";

// googleapis needs the Node runtime; a batch of fetches/AI calls takes a while.
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * One-time repair: walks every known thread and analyzes messages the tracker
 * never saw under the old one-row-per-thread scheme (e.g. interview invites
 * that arrived as replies). Historical — sends no digest alerts.
 *
 * Driven by scripts/backfill.mjs, which loops until done.
 */
export async function POST(request: NextRequest) {
  if (!config.cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${config.cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { limit?: number; maxThreads?: number; startIndex?: number } = {};
  try {
    body = await request.json();
  } catch {
    // no body → defaults
  }

  try {
    const report = await runBackfill({
      limit: body.limit,
      maxThreads: body.maxThreads,
      startIndex: body.startIndex,
    });
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    console.error("Backfill failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

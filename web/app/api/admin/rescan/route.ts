import { NextRequest, NextResponse } from "next/server";
import { runRescan } from "@/lib/ingest/rescan";
import { config } from "@/lib/config";

// googleapis needs the Node runtime; a page of Gmail fetches + AI calls takes a while.
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Recovers past job mail that has no Tracker row (dropped by an older
 * classifier, or older than the tracker). Dry run by default — pass
 * { "dryRun": false } to append. Driven by scripts/rescan.mjs:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *        -H "Content-Type: application/json" -d '{"since":"2026-06-01"}' \
 *        http://localhost:3000/api/admin/rescan
 */
export async function POST(request: NextRequest) {
  if (!config.cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${config.cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    since?: string;
    until?: string;
    dryRun?: boolean;
    limit?: number;
    cursor?: string;
    sent?: boolean;
  } = {};
  try {
    body = await request.json();
  } catch {
    // validated below
  }
  if (!body.since) {
    return NextResponse.json({ ok: false, error: "since (YYYY-MM-DD) is required" }, { status: 400 });
  }

  try {
    const report = await runRescan({
      since: body.since,
      until: body.until,
      dryRun: body.dryRun ?? true,
      limit: body.limit,
      cursor: body.cursor,
      sent: body.sent === true,
    });
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    console.error("Rescan failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

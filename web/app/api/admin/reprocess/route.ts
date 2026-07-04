import { NextRequest, NextResponse } from "next/server";
import { runReprocess } from "@/lib/ingest/reprocess";
import { config } from "@/lib/config";

// googleapis needs the Node runtime; a batch of AI calls takes a while.
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Re-runs the current classifier over cached raw emails and corrects
 * Step/Category/InterviewDateTime (never a manually-edited Status).
 * Defaults to a DRY RUN — pass { "dryRun": false } to apply.
 *
 * Driven by scripts/reprocess.mjs, which loops until done:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *        -H "Content-Type: application/json" -d '{"dryRun":true}' \
 *        http://localhost:3000/api/admin/reprocess
 */
export async function POST(request: NextRequest) {
  if (!config.cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${config.cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { dryRun?: boolean; limit?: number; startRow?: number } = {};
  try {
    body = await request.json();
  } catch {
    // no body → defaults (dry run)
  }

  try {
    const report = await runReprocess({
      dryRun: body.dryRun ?? true,
      limit: body.limit,
      startRow: body.startRow,
    });
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    console.error("Reprocess failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

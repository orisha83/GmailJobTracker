import { NextRequest, NextResponse } from "next/server";
import { makeAuthedClient } from "@/lib/google/auth";
import { PIPELINE_STATUSES, updateStatus, type PipelineStatus } from "@/lib/google/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Updates the pipeline status for one opportunity (matched by Gmail message ID). */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const { messageId } = await params; // Next 16: params is async

  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const status = body.status;
  if (!status || !PIPELINE_STATUSES.includes(status as PipelineStatus)) {
    return NextResponse.json(
      { ok: false, error: `status must be one of: ${PIPELINE_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const auth = makeAuthedClient();
    const updated = await updateStatus(auth, messageId, status as PipelineStatus);
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: "No row found for that message ID" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, messageId, status });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

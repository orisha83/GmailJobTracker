import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { makeAuthedClient } from "@/lib/google/auth";
import { appendRows } from "@/lib/google/sheets";
import { buildManualRow } from "@/lib/manual";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Add a manual update to an application ("they called — passed the assignment,
 * next round"). Body: see ManualInput in lib/manual.ts. The row joins the
 * card's history and status like an email; remove it with Hide.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const built = buildManualRow(body, `manual-${randomUUID()}`);
  if ("errors" in built) {
    return NextResponse.json({ ok: false, error: built.errors.join("; ") }, { status: 400 });
  }

  try {
    await appendRows(makeAuthedClient(), [built.row]);
    return NextResponse.json({ ok: true, row: built.row });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

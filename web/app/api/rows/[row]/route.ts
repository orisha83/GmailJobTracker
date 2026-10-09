import { NextRequest, NextResponse } from "next/server";
import { makeAuthedClient } from "@/lib/google/auth";
import { updateRow } from "@/lib/google/sheets";
import { AUTO_STATUS, HIDDEN_STATUS } from "@/lib/positions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROW_STATUSES = new Set([HIDDEN_STATUS, AUTO_STATUS]);

/**
 * Edit ONE email row from the dashboard's email list.
 * Body: { threadId, received, status?: "Hidden" | "Auto", company?: string }
 * threadId + received guard against writing a row the user rearranged by hand.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ row: string }> },
) {
  const rowNumber = Number((await params).row); // Next 16: params is async

  let body: { threadId?: unknown; received?: unknown; status?: unknown; company?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const threadId = typeof body.threadId === "string" ? body.threadId : "";
  const received = typeof body.received === "string" ? body.received : "";
  const status = typeof body.status === "string" ? body.status : undefined;
  const company = typeof body.company === "string" ? body.company.trim() : undefined;
  const errors: string[] = [];
  if (!Number.isInteger(rowNumber) || rowNumber < 2) errors.push("row must be a data row number");
  if (!threadId || !received) errors.push("threadId and received are required");
  if (status !== undefined && !ROW_STATUSES.has(status)) {
    errors.push(`status must be ${[...ROW_STATUSES].join(" or ")}`);
  }
  if (company !== undefined && (company.length < 1 || company.length > 80)) {
    errors.push("company must be 1–80 characters");
  }
  if (status === undefined && company === undefined) errors.push("nothing to change");
  if (errors.length) {
    return NextResponse.json({ ok: false, error: errors.join("; ") }, { status: 400 });
  }

  try {
    const result = await updateRow(makeAuthedClient(), rowNumber, { threadId, received }, { status, company });
    if (result === "not_found") {
      return NextResponse.json({ ok: false, error: "No such row" }, { status: 404 });
    }
    if (result === "mismatch") {
      return NextResponse.json(
        { ok: false, error: "That row changed in the Sheet — refresh and try again" },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, row: rowNumber });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

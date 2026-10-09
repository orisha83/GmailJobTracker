import { NextRequest, NextResponse } from "next/server";
import { makeAuthedClient } from "@/lib/google/auth";
import { readAliases, writeAliases } from "@/lib/google/sheets";
import type { Alias } from "@/lib/positions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY_RE = /^[a-z0-9.\-\u05d0-\u05ea]{1,80}$/;

function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** Manual company merges (fromKey → toKey), applied when cards are grouped. */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, aliases: await readAliases(makeAuthedClient()) });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}

/**
 * Merge a card into another company.
 * Body: { toKey: string, from: { key: string, name: string }[] }
 * Every `from` key now resolves to `toKey`. Existing aliases that would form a
 * cycle (toKey → one of the from keys) or re-point a from key are replaced.
 */
export async function POST(request: NextRequest) {
  let body: { toKey?: unknown; from?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail("Invalid JSON body", 400);
  }
  const toKey = typeof body.toKey === "string" ? body.toKey : "";
  const from = Array.isArray(body.from)
    ? (body.from as { key?: unknown; name?: unknown }[])
        .map((f) => ({ key: String(f?.key ?? ""), name: String(f?.name ?? "").slice(0, 100) }))
        .filter((f) => KEY_RE.test(f.key) && f.key !== toKey)
    : [];
  if (!KEY_RE.test(toKey) || from.length === 0) {
    return fail("toKey and a non-empty from[] of company keys are required", 400);
  }

  try {
    const auth = makeAuthedClient();
    const fromKeys = new Set(from.map((f) => f.key));
    const kept = (await readAliases(auth)).filter(
      (a) => !fromKeys.has(a.fromKey) && !(a.fromKey === toKey && fromKeys.has(a.toKey)),
    );
    const aliases: Alias[] = [
      ...kept,
      ...from.map((f) => ({ fromKey: f.key, toKey, fromName: f.name })),
    ];
    await writeAliases(auth, aliases);
    return NextResponse.json({ ok: true, aliases });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}

/** Undo a merge. Body: { fromKey: string } */
export async function DELETE(request: NextRequest) {
  let body: { fromKey?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail("Invalid JSON body", 400);
  }
  const fromKey = typeof body.fromKey === "string" ? body.fromKey : "";
  if (!KEY_RE.test(fromKey)) return fail("fromKey is required", 400);

  try {
    const auth = makeAuthedClient();
    const current = await readAliases(auth);
    const aliases = current.filter((a) => a.fromKey !== fromKey);
    if (aliases.length === current.length) return fail("No merge found for that key", 404);
    await writeAliases(auth, aliases);
    return NextResponse.json({ ok: true, aliases });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}

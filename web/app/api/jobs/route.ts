import { NextResponse } from "next/server";
import { makeAuthedClient } from "@/lib/google/auth";
import { readAliases, readRows } from "@/lib/google/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns all tracked emails + manual merges from the Sheet, for the dashboard. */
export async function GET() {
  try {
    const auth = makeAuthedClient();
    const [jobs, aliases] = await Promise.all([readRows(auth), readAliases(auth)]);
    return NextResponse.json({ ok: true, count: jobs.length, jobs, aliases });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

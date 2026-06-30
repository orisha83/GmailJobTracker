import { NextResponse } from "next/server";
import { configStatus } from "@/lib/config";

/**
 * Health + config-readiness check. Reports which secrets are still missing so
 * setup progress is visible without exposing any secret values.
 */
export function GET() {
  const status = configStatus([
    "google.clientId",
    "google.clientSecret",
    "google.refreshToken",
    "sheets.spreadsheetId",
    "ai.apiKey",
    "cronSecret",
  ]);

  return NextResponse.json({
    ok: true,
    service: "job-inbox-tracker",
    configReady: status.ok,
    missingConfig: status.missing,
    time: new Date().toISOString(),
  });
}

import { NextResponse } from "next/server";
import { getConsentUrl } from "@/lib/google/auth";

/**
 * Starts the Google OAuth consent flow. Visit this once during setup to grant
 * Gmail + Sheets access and obtain a refresh token (shown by the callback).
 */
export function GET() {
  try {
    return NextResponse.redirect(getConsentUrl());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "OAuth not configured" },
      { status: 500 },
    );
  }
}

/**
 * Central config + secret loader. Single-user MVP: the OAuth refresh token and
 * other secrets live in environment variables (see docs/ArchitectureLite.md §6).
 *
 * Nothing here throws at import time — call `assertConfig()` from routes that
 * need a given secret so the dashboard can still render a helpful error state.
 */

/**
 * Default bilingual (Hebrew + English) keyword filter — broad enough to catch
 * the whole application lifecycle (acknowledgements, invitations, rejections),
 * not just interview invites. The time window is NOT baked in here — the poller
 * appends an `after:` bound for incremental scanning.
 */
export const DEFAULT_SEARCH_QUERY =
  "(" +
  // interview / scheduling
  "interview OR call OR scheduling OR ראיון OR טלפוני OR שיחה OR לתאם OR זימון OR " +
  // application lifecycle (acknowledgements + rejections live here)
  "applying OR application OR applied OR candidate OR candidacy OR recruiting OR recruiter OR " +
  'position OR role OR opportunity OR resume OR "thank you for applying" OR ' +
  // roles / HR
  "HR OR תפקיד OR משרה OR גיוס OR מועמד OR מועמדות OR מועמדותך OR \"קורות חיים\" OR קו\"ח OR דרושים" +
  ")";

/** YYYY/MM/DD floor for the very first scan (before a watermark exists). */
function todayStartDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

/**
 * Reads an env var, treating empty/whitespace-only values as unset. (A bare
 * `KEY=` line in .env produces an empty string, which `??` would NOT fall back
 * from — so we normalize it here.)
 */
function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() !== "" ? v : undefined;
}

const appBaseUrl = env("APP_BASE_URL") ?? "http://localhost:3000";

export const config = {
  google: {
    clientId: env("GOOGLE_CLIENT_ID") ?? "",
    clientSecret: env("GOOGLE_CLIENT_SECRET") ?? "",
    refreshToken: env("GOOGLE_REFRESH_TOKEN") ?? "",
    // Where Google sends the user back after consent.
    redirectUri: env("GOOGLE_REDIRECT_URI") ?? `${appBaseUrl}/api/auth/callback`,
  },
  sheets: {
    spreadsheetId: env("SHEET_ID") ?? "",
    // Visible tracker tab + hidden tabs for processed IDs and scan state.
    dataSheet: env("SHEET_DATA_TAB") ?? "Tracker",
    processedSheet: env("SHEET_PROCESSED_TAB") ?? "Processed",
    metaSheet: env("SHEET_META_TAB") ?? "Meta",
    // Hidden cache of raw email content (subject/body) so misclassified mail
    // can be re-analyzed offline without re-reading Gmail.
    rawSheet: env("SHEET_RAW_TAB") ?? "Raw",
  },
  // Which analyzer to use: "gemini" (default — free tier) or "claude" (paid).
  // Default is Gemini so the tracker runs at $0 out of the box; set
  // AI_PROVIDER=claude to opt into the paid Claude Haiku classifier.
  aiProvider: (env("AI_PROVIDER") ?? "gemini").toLowerCase(),
  anthropic: {
    apiKey: env("ANTHROPIC_API_KEY") ?? "",
    model: env("ANTHROPIC_MODEL") ?? "claude-haiku-4-5",
  },
  gemini: {
    apiKey: env("GEMINI_API_KEY") ?? "",
    // Free-tier daily caps are PER MODEL and can be very low (observed:
    // 20/day for gemini-2.5-flash-lite in 2026-07). Normal polling fits, but
    // for a bulk repair (backfill/reprocess) hop models via GEMINI_MODEL —
    // each model id has its own daily allowance. Deferred mail is retried
    // next run, so hitting the cap loses nothing.
    model: env("GEMINI_MODEL") ?? "gemini-2.5-flash-lite",
  },
  ingest: {
    searchQuery: env("SEARCH_QUERY") ?? DEFAULT_SEARCH_QUERY,
    timezone: env("TIMEZONE") ?? "Asia/Jerusalem",
    notifyEmail: env("NOTIFY_EMAIL") ?? "",
    // Min minutes between notification emails. Updates arriving inside the window
    // are held and rolled into the next digest, so at most one email per window.
    notifyMinIntervalMinutes: Number(env("NOTIFY_MIN_INTERVAL_MINUTES") ?? "60"),
    // First-run floor (YYYY/MM/DD); after that the Sheet watermark takes over.
    startDate: env("INGEST_START_DATE") ?? todayStartDate(),
    // Max emails analyzed (AI calls) per run; bounds the serverless time budget.
    // Claude has high limits, so this is just a per-run safety cap.
    maxPerRun: Number(env("MAX_PER_RUN") ?? "25"),
    throttleMs: Number(env("AI_THROTTLE_MS") ?? "300"),
  },
  // Protects /api/cron/poll so only the scheduler can trigger ingestion.
  cronSecret: env("CRON_SECRET") ?? "",
} as const;

export type ConfigKey =
  | "google.clientId"
  | "google.clientSecret"
  | "google.refreshToken"
  | "sheets.spreadsheetId"
  | "gemini.apiKey"
  | "anthropic.apiKey"
  | "ai.apiKey"
  | "cronSecret";

const RESOLVERS: Record<ConfigKey, () => string> = {
  "google.clientId": () => config.google.clientId,
  "google.clientSecret": () => config.google.clientSecret,
  "google.refreshToken": () => config.google.refreshToken,
  "sheets.spreadsheetId": () => config.sheets.spreadsheetId,
  "gemini.apiKey": () => config.gemini.apiKey,
  "anthropic.apiKey": () => config.anthropic.apiKey,
  // The active provider's key (what actually matters for readiness).
  "ai.apiKey": () => (config.aiProvider === "gemini" ? config.gemini.apiKey : config.anthropic.apiKey),
  cronSecret: () => config.cronSecret,
};

/** Throws if any required key is missing/empty. Call from routes, not at import. */
export function assertConfig(keys: ConfigKey[]): void {
  const missing = keys.filter((k) => !RESOLVERS[k]());
  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration: ${missing.join(", ")}. ` +
        `Set the corresponding environment variables (see docs/ArchitectureLite.md §6).`,
    );
  }
}

/** Non-throwing check, handy for rendering setup/error states in the UI. */
export function configStatus(keys: ConfigKey[]): { ok: boolean; missing: ConfigKey[] } {
  const missing = keys.filter((k) => !RESOLVERS[k]());
  return { ok: missing.length === 0, missing };
}

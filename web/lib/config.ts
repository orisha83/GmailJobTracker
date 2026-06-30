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
  },
  gemini: {
    apiKey: env("GEMINI_API_KEY") ?? "",
    // flash-lite: free tier ~1000 req/day & 15/min (vs only 20/day for
    // gemini-2.5-flash). Plenty for an email tracker; swap via GEMINI_MODEL.
    model: env("GEMINI_MODEL") ?? "gemini-2.5-flash-lite",
  },
  ingest: {
    searchQuery: env("SEARCH_QUERY") ?? DEFAULT_SEARCH_QUERY,
    timezone: env("TIMEZONE") ?? "Asia/Jerusalem",
    notifyEmail: env("NOTIFY_EMAIL") ?? "",
    // First-run floor (YYYY/MM/DD); after that the Sheet watermark takes over.
    startDate: env("INGEST_START_DATE") ?? todayStartDate(),
    // Max AI (Gemini) calls per run — the binding free-tier constraint (~20/day).
    maxPerRun: Number(env("MAX_PER_RUN") ?? "10"),
    throttleMs: Number(env("GEMINI_THROTTLE_MS") ?? "4500"),
    // Max threads fetched+classified per run (rule classification is free, so
    // this only bounds serverless time). Remainder defers to the next run.
    maxFetchPerRun: Number(env("MAX_FETCH_PER_RUN") ?? "30"),
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
  | "cronSecret";

const RESOLVERS: Record<ConfigKey, () => string> = {
  "google.clientId": () => config.google.clientId,
  "google.clientSecret": () => config.google.clientSecret,
  "google.refreshToken": () => config.google.refreshToken,
  "sheets.spreadsheetId": () => config.sheets.spreadsheetId,
  "gemini.apiKey": () => config.gemini.apiKey,
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

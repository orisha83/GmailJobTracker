/**
 * Google Sheets as the source of truth (docs/ArchitectureLite.md §3).
 * Visible "Tracker" tab holds opportunities (cols A–H); hidden "Processed"
 * tab holds Gmail message IDs we've already seen, so the visible table stays
 * clean (no "Not Relevant" junk rows).
 *
 * Ingestion only appends rows and marks processed IDs — it never writes the
 * Status column, so manual edits from the dashboard are never clobbered.
 */
import { google, type sheets_v4 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { config } from "@/lib/config";

// Manual-override choices offered in the dashboard dropdown. Auto statuses set by
// ingestion (the email's "step", e.g. "VP interview") can be any text — these are
// just the curated options a user can switch a position to by hand.
export const PIPELINE_STATUSES = [
  "Applied",
  "Interviewing",
  "Offer",
  "Rejected",
  "Withdrawn",
  "Archived",
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export interface TrackedJob {
  /** 1-based row number in the sheet (header is row 1). */
  rowNumber: number;
  received: string;
  company: string;
  /** Normalized sender domain — robust grouping key for a position. */
  companyKey: string;
  role: string;
  /** This email's step label (immutable record of the round). */
  step: string;
  category: string;
  interviewDateTime: string;
  summary: string;
  /** Current status (initialized to step; overridable by the user). */
  status: string;
  /** "rule" (heuristic) or "ai" (Gemini). */
  source: string;
  /** Gmail thread ID — the dedup key (one conversation = one row). */
  threadId: string;
}

// Column order A..K. Status=I, ThreadID=K.
const HEADER = [
  "Received",
  "Company",
  "CompanyKey",
  "Role",
  "Step",
  "Category",
  "InterviewDateTime",
  "Summary",
  "Status",
  "Source",
  "ThreadID",
];

function sheetsClient(auth: OAuth2Client): sheets_v4.Sheets {
  return google.sheets({ version: "v4", auth });
}

function dataRange(): string {
  return `${config.sheets.dataSheet}!A:K`;
}

/** Reads all tracked opportunities (skips the header row). */
export async function readRows(auth: OAuth2Client): Promise<TrackedJob[]> {
  const sheets = sheetsClient(auth);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: dataRange(),
  });
  const rows = res.data.values ?? [];
  return rows.slice(1).map((r, i) => ({
    rowNumber: i + 2, // +1 for header, +1 for 1-based
    received: r[0] ?? "",
    company: r[1] ?? "",
    companyKey: r[2] ?? "",
    role: r[3] ?? "",
    step: r[4] ?? "",
    category: r[5] ?? "",
    interviewDateTime: r[6] ?? "",
    summary: r[7] ?? "",
    status: r[8] ?? "",
    source: r[9] ?? "",
    threadId: r[10] ?? "",
  }));
}

export interface NewJobRow {
  received: string;
  company: string;
  companyKey: string;
  role: string;
  step: string;
  category: string;
  interviewDateTime: string;
  summary: string;
  status: string;
  source: string;
  threadId: string;
}

function rowValues(job: NewJobRow): (string | number)[] {
  return [
    job.received,
    job.company,
    job.companyKey,
    job.role,
    job.step,
    job.category,
    job.interviewDateTime,
    job.summary,
    job.status,
    job.source,
    job.threadId,
  ];
}

/** Appends many event rows in a single write (avoids the Sheets per-minute write quota). */
export async function appendRows(auth: OAuth2Client, jobs: NewJobRow[]): Promise<void> {
  if (jobs.length === 0) return;
  const sheets = sheetsClient(auth);
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.spreadsheetId,
    range: dataRange(),
    valueInputOption: "USER_ENTERED",
    requestBody: { values: jobs.map(rowValues) },
  });
}

/** Updates the Status cell (col I) for the row of the given thread. */
export async function updateStatus(
  auth: OAuth2Client,
  threadId: string,
  status: string,
): Promise<boolean> {
  const rows = await readRows(auth);
  const match = rows.find((r) => r.threadId === threadId);
  if (!match) return false;

  const sheets = sheetsClient(auth);
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.dataSheet}!I${match.rowNumber}`, // Status is column I
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[status]] },
  });
  return true;
}

/** Returns the set of Gmail THREAD IDs already processed. */
export async function getProcessedThreadIds(auth: OAuth2Client): Promise<Set<string>> {
  const sheets = sheetsClient(auth);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.processedSheet}!A:A`,
  });
  return new Set((res.data.values ?? []).flat().filter(Boolean) as string[]);
}

/** Records that threads have been processed (one batched write). */
export async function markProcessedBatch(
  auth: OAuth2Client,
  threadIds: string[],
): Promise<void> {
  if (threadIds.length === 0) return;
  const sheets = sheetsClient(auth);
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.processedSheet}!A:A`,
    valueInputOption: "RAW",
    requestBody: { values: threadIds.map((id) => [id]) },
  });
}

/**
 * Ensures both tabs and the header row exist. Idempotent — safe to call on
 * startup or before the first poll. Creates missing tabs and writes the header.
 */
export async function ensureSheets(auth: OAuth2Client): Promise<void> {
  const sheets = sheetsClient(auth);
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.sheets.spreadsheetId,
  });
  const titles = new Set(
    (meta.data.sheets ?? []).map((s) => s.properties?.title).filter(Boolean) as string[],
  );

  const toCreate = [
    config.sheets.dataSheet,
    config.sheets.processedSheet,
    config.sheets.metaSheet,
  ].filter((t) => !titles.has(t));
  if (toCreate.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheets.spreadsheetId,
      requestBody: {
        requests: toCreate.map((title) => ({ addSheet: { properties: { title } } })),
      },
    });
  }

  // Write the header on the data tab if A1 is empty.
  const head = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.dataSheet}!A1:K1`,
  });
  if (!head.data.values || head.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${config.sheets.dataSheet}!A1:K1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
  }
}

/**
 * Incremental-scan watermark (epoch seconds) stored in Meta!B1. Returns null
 * when unset (first run) so the poller falls back to the configured start date.
 */
export async function getLastChecked(auth: OAuth2Client): Promise<number | null> {
  const sheets = sheetsClient(auth);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.metaSheet}!B1`,
  });
  const raw = res.data.values?.[0]?.[0];
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function setLastChecked(
  auth: OAuth2Client,
  epochSeconds: number,
): Promise<void> {
  const sheets = sheetsClient(auth);
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.metaSheet}!A1:B1`,
    valueInputOption: "RAW",
    requestBody: { values: [["lastCheckedEpoch", epochSeconds]] },
  });
}

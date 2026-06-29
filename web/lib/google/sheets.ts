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

export const PIPELINE_STATUSES = [
  "Review Needed",
  "Replied",
  "Scheduled",
  "Done",
  "Rejected",
  "Archived",
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export interface TrackedJob {
  /** 1-based row number in the sheet (header is row 1). */
  rowNumber: number;
  received: string;
  company: string;
  role: string;
  type: string;
  category: string;
  interviewDateTime: string;
  summary: string;
  status: string;
  /** Gmail thread ID — the dedup + status key (one conversation = one row). */
  threadId: string;
}

// Column order: A..I. Category sits next to Type; Status=H, ThreadID=I.
const HEADER = [
  "Received",
  "Company",
  "Role",
  "Type",
  "Category",
  "InterviewDateTime",
  "Summary",
  "Status",
  "ThreadID",
];

function sheetsClient(auth: OAuth2Client): sheets_v4.Sheets {
  return google.sheets({ version: "v4", auth });
}

function dataRange(): string {
  return `${config.sheets.dataSheet}!A:I`;
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
    role: r[2] ?? "",
    type: r[3] ?? "",
    category: r[4] ?? "",
    interviewDateTime: r[5] ?? "",
    summary: r[6] ?? "",
    status: r[7] ?? "",
    threadId: r[8] ?? "",
  }));
}

export interface NewJobRow {
  received: string;
  company: string;
  role: string;
  type: string;
  category: string;
  interviewDateTime: string;
  summary: string;
  status: string;
  threadId: string;
}

/** Appends one opportunity row. */
export async function appendRow(auth: OAuth2Client, job: NewJobRow): Promise<void> {
  const sheets = sheetsClient(auth);
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.spreadsheetId,
    range: dataRange(),
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          job.received,
          job.company,
          job.role,
          job.type,
          job.category,
          job.interviewDateTime,
          job.summary,
          job.status,
          job.threadId,
        ],
      ],
    },
  });
}

/** Updates the Status cell (col G) for the row whose MessageID matches. */
export async function updateStatus(
  auth: OAuth2Client,
  threadId: string,
  status: PipelineStatus,
): Promise<boolean> {
  const rows = await readRows(auth);
  const match = rows.find((r) => r.threadId === threadId);
  if (!match) return false;

  const sheets = sheetsClient(auth);
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.dataSheet}!H${match.rowNumber}`, // Status is column H
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

/** Records that a thread has been processed (relevant or not). */
export async function markProcessed(auth: OAuth2Client, threadId: string): Promise<void> {
  const sheets = sheetsClient(auth);
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.processedSheet}!A:A`,
    valueInputOption: "RAW",
    requestBody: { values: [[threadId]] },
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
    range: `${config.sheets.dataSheet}!A1:I1`,
  });
  if (!head.data.values || head.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${config.sheets.dataSheet}!A1:I1`,
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

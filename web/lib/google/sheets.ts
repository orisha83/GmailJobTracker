/**
 * Google Sheets as the source of truth (docs/ArchitectureLite.md §3).
 * Visible "Tracker" tab holds one row per analyzed email (cols A–N); hidden
 * "Processed" tab holds Gmail message IDs we've already seen; hidden "Raw" tab
 * caches raw email content for offline re-classification.
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
  /** Gmail thread ID this email belongs to (one conversation, many rows). */
  threadId: string;
  /** Best job/careers/position URL extracted from the email, or "". */
  link: string;
  /** Full name of the interviewer named in the email, or "". */
  interviewer: string;
  /** Gmail message ID — the dedup key (one email = one row). Empty on rows
   *  ingested before per-message tracking (backfilled by scripts/backfill). */
  messageId: string;
}

// Column order A..N. Status=I, ThreadID=K, Link=L, Interviewer=M, MessageID=N.
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
  "Link",
  "Interviewer",
  "MessageID",
];

function sheetsClient(auth: OAuth2Client): sheets_v4.Sheets {
  return google.sheets({ version: "v4", auth });
}

function dataRange(): string {
  return `${config.sheets.dataSheet}!A:N`;
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
    link: r[11] ?? "",
    interviewer: r[12] ?? "",
    messageId: r[13] ?? "",
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
  link: string;
  interviewer: string;
  messageId: string;
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
    job.link,
    job.interviewer,
    job.messageId,
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

/**
 * Updates the Status cell (col I) for one row. `id` is a Gmail messageId
 * (exact row) or, for pre-migration rows without one, a threadId — resolved to
 * that thread's LATEST row, since that's the row the dashboard's derived
 * status reads from.
 */
export async function updateStatus(
  auth: OAuth2Client,
  id: string,
  status: string,
): Promise<boolean> {
  const rows = await readRows(auth);
  const match =
    rows.find((r) => r.messageId === id) ??
    rows
      .filter((r) => r.threadId === id)
      .sort((a, b) => (b.received || "").localeCompare(a.received || ""))[0];
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

/** Raw email content cached at ingest so classification can be re-run offline
 *  (no Gmail round-trip, no re-read quota) whenever the classifier improves. */
export interface RawEmail {
  messageId: string;
  threadId: string;
  received: string;
  senderName: string;
  senderDomain: string;
  subject: string;
  body: string;
  links: string[];
}

// Matches the larger of the two analyzers' input truncations (Claude: 4000,
// Gemini: 3000) — a cached body can always feed either model. Sheets cells
// hold up to ~50k chars, so this is comfortably safe.
const RAW_BODY_MAX = 4000;

/** Appends raw emails to the hidden Raw tab (one batched write). */
export async function appendRawEmails(auth: OAuth2Client, entries: RawEmail[]): Promise<void> {
  if (entries.length === 0) return;
  const sheets = sheetsClient(auth);
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.rawSheet}!A:H`,
    valueInputOption: "RAW",
    requestBody: {
      values: entries.map((e) => [
        e.messageId,
        e.threadId,
        e.received,
        e.senderName,
        e.senderDomain,
        e.subject,
        (e.body || "").slice(0, RAW_BODY_MAX),
        JSON.stringify((e.links ?? []).slice(0, 15)),
      ]),
    },
  });
}

/** Reads the whole Raw cache, keyed by messageId. */
export async function readRawEmails(auth: OAuth2Client): Promise<Map<string, RawEmail>> {
  const sheets = sheetsClient(auth);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.rawSheet}!A:H`,
  });
  const map = new Map<string, RawEmail>();
  for (const r of res.data.values ?? []) {
    const messageId = (r[0] as string) ?? "";
    if (!messageId) continue;
    let links: unknown = [];
    try {
      links = JSON.parse((r[7] as string) || "[]");
    } catch {
      links = [];
    }
    map.set(messageId, {
      messageId,
      threadId: r[1] ?? "",
      received: r[2] ?? "",
      senderName: r[3] ?? "",
      senderDomain: r[4] ?? "",
      subject: r[5] ?? "",
      body: r[6] ?? "",
      links: Array.isArray(links) ? (links as string[]) : [],
    });
  }
  return map;
}

/** Batched cell updates in one API call — used by the repair tools. */
export async function batchUpdateValues(
  auth: OAuth2Client,
  data: { range: string; values: (string | number)[][] }[],
): Promise<void> {
  if (data.length === 0) return;
  const sheets = sheetsClient(auth);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: config.sheets.spreadsheetId,
    requestBody: { valueInputOption: "USER_ENTERED", data },
  });
}

/** One processed email: dedup on messageId; threadId kept for repair tools. */
export interface ProcessedEntry {
  messageId: string;
  threadId: string;
}

export interface ProcessedIds {
  /** Message IDs already analyzed (or settled as noise). */
  messageIds: Set<string>;
  /** Legacy v1 markers (whole thread processed, pre per-message tracking).
   *  These suppress only mail older than the watermark — newer replies in the
   *  same thread must still be analyzed. */
  legacyThreadIds: Set<string>;
}

/**
 * Reads the Processed tab. v2 rows are `messageId | threadId | processedAt`;
 * legacy v1 rows hold a bare threadId in column A. A Gmail threadId equals its
 * FIRST message's id, so legacy markers also count as that message's dedup key.
 */
export async function getProcessedIds(auth: OAuth2Client): Promise<ProcessedIds> {
  const sheets = sheetsClient(auth);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.processedSheet}!A:B`,
  });
  const messageIds = new Set<string>();
  const legacyThreadIds = new Set<string>();
  for (const row of res.data.values ?? []) {
    const a = (row[0] as string) ?? "";
    const b = (row[1] as string) ?? "";
    if (!a) continue;
    messageIds.add(a);
    if (!b) legacyThreadIds.add(a);
  }
  return { messageIds, legacyThreadIds };
}

/** Records processed emails (one batched write). */
export async function markProcessedBatch(
  auth: OAuth2Client,
  entries: ProcessedEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const sheets = sheetsClient(auth);
  const processedAt = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.processedSheet}!A:C`,
    valueInputOption: "RAW",
    requestBody: { values: entries.map((e) => [e.messageId, e.threadId, processedAt]) },
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
    config.sheets.rawSheet,
  ].filter((t) => !titles.has(t));
  if (toCreate.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheets.spreadsheetId,
      requestBody: {
        requests: toCreate.map((title) => ({ addSheet: { properties: { title } } })),
      },
    });
  }

  // Write the header if A1 is empty, or refresh it when it's from an older
  // schema with fewer columns (header-row only — data rows are untouched).
  const head = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.dataSheet}!A1:N1`,
  });
  if ((head.data.values?.[0] ?? []).length < HEADER.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${config.sheets.dataSheet}!A1:N1`,
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

/**
 * Notification state, kept just below the ingest watermark:
 *   Meta!B2 — lastNotifiedEpoch (epoch seconds of the last digest sent)
 *   Meta!B3 — pending alert items, as an opaque JSON string (held until the
 *             hourly gate opens, so updates within the hour are never lost).
 * `setLastChecked` writes A1:B1 only and this writes A2:B3 only, so they don't
 * clobber each other.
 */
export async function getNotifyState(
  auth: OAuth2Client,
): Promise<{ lastNotifiedEpoch: number | null; pendingJson: string }> {
  const sheets = sheetsClient(auth);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.metaSheet}!A2:B3`,
  });
  const rows = res.data.values ?? [];
  const epochRaw = rows[0]?.[1]; // B2
  const n = epochRaw != null ? Number(epochRaw) : NaN;
  const pendingJson = (rows[1]?.[1] as string) ?? ""; // B3
  return {
    lastNotifiedEpoch: Number.isFinite(n) && n > 0 ? n : null,
    pendingJson: typeof pendingJson === "string" ? pendingJson : "",
  };
}

export async function setNotifyState(
  auth: OAuth2Client,
  lastNotifiedEpoch: number,
  pendingJson: string,
): Promise<void> {
  const sheets = sheetsClient(auth);
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${config.sheets.metaSheet}!A2:B3`,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        ["lastNotifiedEpoch", lastNotifiedEpoch],
        ["pendingAlerts", pendingJson],
      ],
    },
  });
}

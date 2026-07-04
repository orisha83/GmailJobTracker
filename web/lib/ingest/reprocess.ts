/**
 * Offline re-classification: re-runs the CURRENT classifier (rules → gate →
 * AI + offer guard) over the cached raw emails and corrects Step / Category /
 * InterviewDateTime on existing Tracker rows. The Status column is corrected
 * only when the user never edited it (status still equals the old step) — a
 * manual override is never clobbered.
 *
 * Resumable: rows are processed in sheet order from `startRow`; when the AI
 * budget for one invocation is spent, the report returns done=false and
 * `nextRow`, and the caller re-invokes from there. Rows whose raw content was
 * never cached (pre-Raw-tab ingests) are recovered from Gmail and cached.
 */
import { makeAuthedClient } from "@/lib/google/auth";
import { fetchMessage, listThreadMessageIds, type FetchedMessage } from "@/lib/google/gmail";
import {
  appendRawEmails,
  batchUpdateValues,
  ensureSheets,
  readRawEmails,
  readRows,
  type RawEmail,
  type TrackedJob,
} from "@/lib/google/sheets";
import { classifyHeuristically, looksLikeInvitation } from "@/lib/classify/heuristics";
import { guardOfferDowngrade, stripSelfInterviewer, type EmailAnalyzer } from "@/lib/ai/analyzer";
import { getAnalyzer } from "@/lib/ai";
import { config } from "@/lib/config";

export interface ReprocessChange {
  rowNumber: number;
  company: string;
  role: string;
  field: "step" | "category" | "interviewDateTime" | "status";
  oldValue: string;
  newValue: string;
}

export interface ReprocessReport {
  rowsExamined: number;
  reclassified: number; // rows that got a fresh classification (rule or AI)
  aiCalls: number;
  backfilledRaw: number; // raw entries recovered from Gmail
  skippedNoRaw: number; // rows whose content couldn't be recovered
  failed: number; // AI errored on these rows (quota/safety) — rerun to retry
  changes: ReprocessChange[];
  applied: boolean;
  done: boolean; // false → budget hit; call again with startRow = nextRow
  nextRow?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toFetchedMessage(raw: RawEmail): FetchedMessage {
  return {
    id: raw.messageId,
    threadId: raw.threadId,
    subject: raw.subject,
    body: raw.body,
    date: raw.received,
    senderName: raw.senderName,
    senderDomain: raw.senderDomain,
    links: raw.links,
    isSelfNotification: false,
  };
}

/** Find the row's raw content: cache by messageId, cache by (threadId, received),
 *  else re-fetch from Gmail (and remember it for next time). */
async function resolveRaw(
  auth: ReturnType<typeof makeAuthedClient>,
  row: TrackedJob,
  rawByMessageId: Map<string, RawEmail>,
  recovered: RawEmail[],
): Promise<RawEmail | null> {
  if (row.messageId && rawByMessageId.has(row.messageId)) {
    return rawByMessageId.get(row.messageId)!;
  }
  for (const raw of rawByMessageId.values()) {
    if (raw.threadId === row.threadId && raw.received === row.received) return raw;
  }

  // Not cached (ingested before the Raw tab existed) — recover from Gmail.
  try {
    let messageId = row.messageId;
    if (!messageId && row.threadId) {
      const ids = await listThreadMessageIds(auth, row.threadId);
      messageId = ids.find((m) => m.internalDate === row.received)?.messageId ?? "";
    }
    if (!messageId) return null;
    const msg = await fetchMessage(auth, messageId);
    if (!msg) return null;
    const raw: RawEmail = {
      messageId: msg.id,
      threadId: msg.threadId || row.threadId,
      received: msg.date,
      senderName: msg.senderName,
      senderDomain: msg.senderDomain,
      subject: msg.subject,
      body: msg.body,
      links: msg.links,
    };
    rawByMessageId.set(raw.messageId, raw);
    recovered.push(raw);
    return raw;
  } catch (err) {
    console.error(`Raw backfill failed for row ${row.rowNumber}:`, err);
    return null;
  }
}

export async function runReprocess(
  opts: { dryRun?: boolean; limit?: number; startRow?: number } = {},
  analyzer: EmailAnalyzer = getAnalyzer(),
): Promise<ReprocessReport> {
  const dryRun = opts.dryRun ?? true;
  const limit = opts.limit ?? config.ingest.maxPerRun;
  const startRow = opts.startRow ?? 2; // row 1 is the header

  const auth = makeAuthedClient();
  await ensureSheets(auth); // the Raw tab may not exist yet on older sheets
  const rows = (await readRows(auth)).filter((r) => r.rowNumber >= startRow);
  const rawByMessageId = await readRawEmails(auth);
  const recovered: RawEmail[] = [];

  const report: ReprocessReport = {
    rowsExamined: 0,
    reclassified: 0,
    aiCalls: 0,
    backfilledRaw: 0,
    skippedNoRaw: 0,
    failed: 0,
    changes: [],
    applied: !dryRun,
    done: true,
  };
  const updates: { range: string; values: string[][] }[] = [];
  const sheet = config.sheets.dataSheet;

  for (const row of rows) {
    const raw = await resolveRaw(auth, row, rawByMessageId, recovered);
    if (!raw) {
      report.rowsExamined++;
      report.skippedNoRaw++;
      continue;
    }

    const message = toFetchedMessage(raw);
    let analysis = classifyHeuristically(message);
    let source: "rule" | "ai" = "rule";
    if (!analysis) {
      // No rule match. If there's no interview signal either, leave the row as
      // classified originally — reprocess corrects, it never degrades.
      if (!looksLikeInvitation(message)) {
        report.rowsExamined++;
        continue;
      }
      if (report.aiCalls >= limit) {
        // Budget spent — stop here; the caller resumes from this row.
        report.done = false;
        report.nextRow = row.rowNumber;
        break;
      }
      if (report.aiCalls > 0) await sleep(config.ingest.throttleMs);
      report.aiCalls++;
      source = "ai";
      analysis = await analyzer.analyze({
        subject: message.subject,
        body: message.body,
        emailDate: message.date,
        senderName: message.senderName,
        senderDomain: message.senderDomain,
        links: message.links,
      });
      if (!analysis) {
        // Model failure (quota/safety/transient) — skip this row and keep
        // going so one poisoned email can't block the rest of the sheet.
        // A rerun retries it (nothing is persisted for the row).
        report.rowsExamined++;
        report.failed++;
        continue;
      }
      analysis = guardOfferDowngrade(analysis, `${message.subject}\n${message.body}`);
      analysis = stripSelfInterviewer(analysis, config.ingest.candidateName);
    }

    report.rowsExamined++;
    report.reclassified++;
    if (!analysis.is_relevant) continue; // never degrade an existing row

    // The rules classifier only outranks the original classification for
    // rejections (high-precision regex). A rule "Applied" must never downgrade
    // a row the AI read as Invitation/Rejection/Offer — the model saw context
    // (e.g. "invite you to a phone interview" + ack boilerplate) that the
    // regexes don't.
    if (
      source === "rule" &&
      analysis.category === "Applied" &&
      row.category !== "Applied" &&
      row.category !== "Other" &&
      row.category !== ""
    ) {
      continue;
    }

    const newStep = analysis.step;
    const newCategory = analysis.category;
    // Rules can't extract datetimes — a rule result never clears one the AI found.
    const newInterview =
      source === "rule" && !analysis.interview_datetime
        ? row.interviewDateTime
        : (analysis.interview_datetime ?? "");
    const rowChanges: ReprocessChange[] = [];
    const base = { rowNumber: row.rowNumber, company: row.company, role: row.role };
    if (newStep !== row.step) {
      rowChanges.push({ ...base, field: "step", oldValue: row.step, newValue: newStep });
    }
    if (newCategory !== row.category) {
      rowChanges.push({ ...base, field: "category", oldValue: row.category, newValue: newCategory });
    }
    if (newInterview !== row.interviewDateTime) {
      rowChanges.push({
        ...base,
        field: "interviewDateTime",
        oldValue: row.interviewDateTime,
        newValue: newInterview,
      });
    }
    if (rowChanges.length === 0) continue;

    report.changes.push(...rowChanges);
    updates.push({
      range: `${sheet}!E${row.rowNumber}:G${row.rowNumber}`,
      values: [[newStep, newCategory, newInterview]],
    });
    // Correct Status only when it still mirrors the old step — i.e. the user
    // never touched it. (Also keeps the manual-override detection in
    // lib/positions.ts honest: status must track step for auto rows.)
    if (row.status === row.step && newStep !== row.status) {
      report.changes.push({ ...base, field: "status", oldValue: row.status, newValue: newStep });
      updates.push({ range: `${sheet}!I${row.rowNumber}`, values: [[newStep]] });
    }
  }

  await appendRawEmails(auth, recovered);
  report.backfilledRaw = recovered.length;
  if (!dryRun) await batchUpdateValues(auth, updates);
  return report;
}

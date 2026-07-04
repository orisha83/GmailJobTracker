/**
 * One-time repair for the per-thread era: under the old scheme a thread was
 * marked processed after its first sighting, so replies that arrived later —
 * including interview invitations — were never analyzed. This walks every
 * known thread, finds messages the tracker has never seen, and:
 *   - migration: a message that matches an existing Tracker row gets its
 *     MessageID written to that row (col N), is cached in Raw, and marked
 *     processed — no AI spent;
 *   - recovery: a never-analyzed message goes through the normal pipeline
 *     (rules → noise gate → AI + offer guard) and, if relevant, is appended
 *     as a new Tracker row.
 * No digest alerts are sent — these are historical items, not news.
 *
 * Resumable: threads are processed in sorted order from `startIndex`; when the
 * per-invocation AI budget or thread cap is hit, the report returns done=false
 * and `nextIndex` to continue from.
 */
import { makeAuthedClient } from "@/lib/google/auth";
import { fetchMessage, listThreadMessageIds } from "@/lib/google/gmail";
import {
  appendRawEmails,
  appendRows,
  batchUpdateValues,
  ensureSheets,
  getProcessedIds,
  markProcessedBatch,
  readRows,
  type NewJobRow,
  type ProcessedEntry,
  type RawEmail,
} from "@/lib/google/sheets";
import { classifyHeuristically, looksLikeInvitation } from "@/lib/classify/heuristics";
import { guardOfferDowngrade, stripSelfInterviewer, type EmailAnalyzer } from "@/lib/ai/analyzer";
import { getAnalyzer } from "@/lib/ai";
import { config } from "@/lib/config";

export interface BackfillReport {
  threadsScanned: number;
  messagesSeen: number;
  migrated: number; // existing rows that got their MessageID + raw cache
  appended: number; // recovered messages that produced new Tracker rows
  noise: number; // unseen messages settled as noise (no row)
  aiCalls: number;
  failed: number;
  done: boolean; // false → budget/cap hit; call again with startIndex = nextIndex
  nextIndex?: number;
}

/** Stable position key from the company name (mirrors poll.ts). */
function companyKeyFor(company: string, domain: string): string {
  const slug = (company || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  if (slug && slug !== "unknown") return slug;
  return (domain || "").toLowerCase().trim() || "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runBackfill(
  opts: { limit?: number; maxThreads?: number; startIndex?: number } = {},
  analyzer: EmailAnalyzer = getAnalyzer(),
): Promise<BackfillReport> {
  const limit = opts.limit ?? config.ingest.maxPerRun;
  const maxThreads = opts.maxThreads ?? 40; // bounds Gmail fetches per invocation
  const startIndex = opts.startIndex ?? 0;

  const auth = makeAuthedClient();
  await ensureSheets(auth); // the Raw tab may not exist yet on older sheets
  const rows = await readRows(auth);
  const processed = await getProcessedIds(auth);

  // Every thread we know about: tracked rows + processed markers (the latter
  // covers noise-marked threads that never produced a row).
  const threadIds = new Set<string>();
  for (const r of rows) if (r.threadId) threadIds.add(r.threadId);
  for (const e of processed.legacyThreadIds) threadIds.add(e);
  const allThreads = [...threadIds].sort();

  const rowsByThread = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = rowsByThread.get(r.threadId) ?? [];
    arr.push(r);
    rowsByThread.set(r.threadId, arr);
  }

  const report: BackfillReport = {
    threadsScanned: 0,
    messagesSeen: 0,
    migrated: 0,
    appended: 0,
    noise: 0,
    aiCalls: 0,
    failed: 0,
    done: true,
  };

  const newRows: NewJobRow[] = [];
  const rawToAppend: RawEmail[] = [];
  const processedIds: ProcessedEntry[] = [];
  const migrationWrites: { range: string; values: string[][] }[] = [];
  const sheet = config.sheets.dataSheet;

  let index = startIndex;
  outer: for (; index < allThreads.length; index++) {
    if (report.threadsScanned >= maxThreads) {
      report.done = false;
      break;
    }
    const threadId = allThreads[index];
    let messages: { messageId: string; internalDate: string }[];
    try {
      messages = await listThreadMessageIds(auth, threadId);
    } catch (err) {
      console.error(`Backfill: listing thread ${threadId} failed:`, err);
      report.failed++;
      continue;
    }
    report.threadsScanned++;

    const threadRows = rowsByThread.get(threadId) ?? [];
    for (const { messageId, internalDate } of messages) {
      if (processed.messageIds.has(messageId)) continue;
      report.messagesSeen++;

      // Migration: this message already has a Tracker row (written when it was
      // the thread's latest at scan time) — just link and cache it.
      const known = threadRows.find((r) => !r.messageId && r.received === internalDate);
      if (known) {
        const msg = await fetchMessage(auth, messageId);
        if (msg) {
          rawToAppend.push({
            messageId,
            threadId,
            received: msg.date,
            senderName: msg.senderName,
            senderDomain: msg.senderDomain,
            subject: msg.subject,
            body: msg.body,
            links: msg.links,
          });
        }
        migrationWrites.push({ range: `${sheet}!N${known.rowNumber}`, values: [[messageId]] });
        known.messageId = messageId; // don't match this row twice
        processedIds.push({ messageId, threadId });
        processed.messageIds.add(messageId);
        report.migrated++;
        continue;
      }

      // Recovery: a message the tracker never analyzed (e.g. an interview
      // invite that arrived as a reply in an already-processed thread).
      const message = await fetchMessage(auth, messageId);
      if (!message) {
        report.failed++;
        continue;
      }
      if (message.isSelfNotification) {
        processedIds.push({ messageId, threadId });
        continue;
      }

      let analysis = classifyHeuristically(message);
      let source = "rule";
      if (!analysis) {
        if (!looksLikeInvitation(message)) {
          report.noise++;
          processedIds.push({ messageId, threadId });
          continue;
        }
        if (report.aiCalls >= limit) {
          report.done = false;
          break outer; // resume THIS thread next invocation (nothing marked)
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
          report.failed++;
          continue; // transient — retried on the next backfill pass
        }
        analysis = guardOfferDowngrade(analysis, `${message.subject}\n${message.body}`);
        analysis = stripSelfInterviewer(analysis, config.ingest.candidateName);
      }

      rawToAppend.push({
        messageId,
        threadId,
        received: message.date,
        senderName: message.senderName,
        senderDomain: message.senderDomain,
        subject: message.subject,
        body: message.body,
        links: message.links,
      });

      if (analysis.is_relevant) {
        newRows.push({
          received: message.date,
          company: analysis.company,
          companyKey: companyKeyFor(analysis.company, message.senderDomain),
          role: analysis.role,
          step: analysis.step,
          category: analysis.category,
          interviewDateTime: analysis.interview_datetime ?? "",
          summary: analysis.summary,
          status: analysis.step,
          source,
          threadId,
          link: analysis.apply_url ?? "",
          interviewer: analysis.interviewer_name ?? "",
          messageId,
        });
        report.appended++;
      } else {
        report.noise++;
      }
      processedIds.push({ messageId, threadId });
    }
  }
  if (!report.done) report.nextIndex = index;

  // Rows and raw first, processed markers last (never mark unsaved work).
  await appendRows(auth, newRows);
  await appendRawEmails(auth, rawToAppend);
  await batchUpdateValues(auth, migrationWrites);
  await markProcessedBatch(auth, processedIds);
  return report;
}

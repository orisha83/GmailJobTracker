/**
 * Ingestion orchestration: Gmail search → dedup → analyze → Sheet + notify.
 * Invoked hourly by /api/cron/poll (and manually during dev).
 * See docs/ArchitectureLite.md §2.
 */
import { makeAuthedClient } from "@/lib/google/auth";
import { searchThreads, fetchMessage } from "@/lib/google/gmail";
import {
  appendRows,
  ensureSheets,
  getLastChecked,
  getProcessedThreadIds,
  markProcessedBatch,
  setLastChecked,
  type NewJobRow,
} from "@/lib/google/sheets";
import { notifyNewOpportunity } from "@/lib/notify";
import { config } from "@/lib/config";
import type { Analysis, EmailAnalyzer } from "@/lib/ai/analyzer";
import { GeminiAnalyzer } from "@/lib/ai/gemini";
import { classifyHeuristically, looksLikeInvitation } from "@/lib/classify/heuristics";

export interface PollResult {
  scanned: number; // threads handled (rule + ai)
  skipped: number; // already processed
  relevant: number; // logged
  invitations: number; // relevant AND category === "Invitation" (alerted)
  ruleClassified: number; // acks/rejections handled free (no AI)
  aiCalls: number; // Gemini calls made (counts against the daily quota)
  irrelevant: number;
  failed: number; // analyzer returned null
  deferred: number; // left for the next run (a cap was reached)
  query: string; // the Gmail query used (for visibility)
}

/** Stable position key from a company name when no sender domain is available. */
function companySlug(company: string): string {
  return (company || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-query a little before the watermark so nothing slips through the boundary;
// the Processed-ID set prevents double-processing the overlap.
const OVERLAP_SECONDS = 600;

/**
 * Runs one ingestion pass. `analyzer` is injectable for testing / future
 * provider swaps; defaults to Gemini.
 */
export async function runPoll(
  analyzer: EmailAnalyzer = new GeminiAnalyzer(),
): Promise<PollResult> {
  const auth = makeAuthedClient();
  await ensureSheets(auth);

  // Delta scanning: only look at mail since the last successful run. On the
  // first run (no watermark) fall back to the configured start date.
  const lastChecked = await getLastChecked(auth);
  const timeBound =
    lastChecked != null
      ? `after:${Math.max(0, lastChecked - OVERLAP_SECONDS)}`
      : `after:${config.ingest.startDate}`;
  const query = `${config.ingest.searchQuery} ${timeBound}`;
  const runStartedEpoch = Math.floor(Date.now() / 1000);

  const result: PollResult = {
    scanned: 0,
    skipped: 0,
    relevant: 0,
    invitations: 0,
    ruleClassified: 0,
    aiCalls: 0,
    irrelevant: 0,
    failed: 0,
    deferred: 0,
    query,
  };

  // One hit per thread (conversation), newest first — collapses reply chains,
  // calendar invites and reminders into a single tracked opportunity.
  const threads = await searchThreads(auth, query);
  const processed = await getProcessedThreadIds(auth);

  // Accumulate writes and alerts; flush in one batch each at the end to stay
  // under the Sheets per-minute write quota.
  const rowsToAppend: NewJobRow[] = [];
  const processedIds: string[] = [];
  const alerts: { subject: string; analysis: Analysis }[] = [];

  let attempts = 0; // threads fetched this run (bounds serverless time)
  for (const { threadId, latestMessageId } of threads) {
    if (processed.has(threadId)) {
      result.skipped++;
      continue;
    }
    if (attempts >= config.ingest.maxFetchPerRun) {
      result.deferred++;
      continue;
    }
    attempts++;

    const message = await fetchMessage(auth, latestMessageId);
    if (!message) {
      result.failed++;
      continue;
    }

    // Rule-first: acks/rejections are classified for free; only the rest cost AI.
    let analysis = classifyHeuristically(message);
    let source = "rule";
    if (!analysis) {
      // Not an ack/rejection. Only spend a (capped) AI call when it looks like a
      // real interview/recruiter email; otherwise it's broad-query noise — skip
      // it for free so newsletters don't burn the daily AI budget.
      if (!looksLikeInvitation(message)) {
        result.irrelevant++;
        processedIds.push(threadId); // settled — don't refetch it
        continue;
      }
      // Needs AI — but the daily Gemini budget is small. Defer once it's spent.
      if (result.aiCalls >= config.ingest.maxPerRun) {
        result.deferred++;
        continue; // not marked processed → retried next run
      }
      if (result.aiCalls > 0) await sleep(config.ingest.throttleMs);
      result.aiCalls++;
      source = "ai";
      analysis = await analyzer.analyze({
        subject: message.subject,
        body: message.body,
        emailDate: message.date,
      });
      if (!analysis) {
        result.failed++;
        continue; // transient AI failure → retry next run (not marked processed)
      }
    } else {
      result.ruleClassified++;
    }

    result.scanned++;
    const companyKey = (message.senderDomain || "").trim() || companySlug(analysis.company);

    if (analysis.is_relevant) {
      rowsToAppend.push({
        received: message.date,
        company: analysis.company,
        companyKey,
        role: analysis.role,
        step: analysis.step,
        category: analysis.category,
        interviewDateTime: analysis.interview_datetime ?? "",
        summary: analysis.summary,
        status: analysis.step, // current status = this email's step (overridable)
        source,
        threadId,
      });
      if (analysis.category === "Invitation") {
        alerts.push({ subject: message.subject, analysis });
        result.invitations++;
      }
      result.relevant++;
    } else {
      result.irrelevant++;
    }

    processedIds.push(threadId);
  }

  // Flush: rows first, then processed markers (so a row is never marked
  // processed without being saved), then alerts.
  await appendRows(auth, rowsToAppend);
  await markProcessedBatch(auth, processedIds);
  for (const a of alerts) await notifyNewOpportunity(auth, a.subject, a.analysis);

  // Advance the watermark only when fully caught up — anything deferred or
  // failed is older (we scan newest first), so leaving the watermark put keeps
  // those items inside the next run's `after:` window until they're handled.
  if (result.deferred === 0 && result.failed === 0) {
    await setLastChecked(auth, runStartedEpoch);
  }

  return result;
}

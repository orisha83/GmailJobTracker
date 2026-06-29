/**
 * Ingestion orchestration: Gmail search → dedup → analyze → Sheet + notify.
 * Invoked hourly by /api/cron/poll (and manually during dev).
 * See docs/ArchitectureLite.md §2.
 */
import { makeAuthedClient } from "@/lib/google/auth";
import { searchThreads, fetchMessage } from "@/lib/google/gmail";
import {
  appendRow,
  ensureSheets,
  getLastChecked,
  getProcessedThreadIds,
  markProcessed,
  setLastChecked,
} from "@/lib/google/sheets";
import { notifyNewOpportunity } from "@/lib/notify";
import { config } from "@/lib/config";
import type { EmailAnalyzer } from "@/lib/ai/analyzer";
import { GeminiAnalyzer } from "@/lib/ai/gemini";

export interface PollResult {
  scanned: number;
  skipped: number; // already processed
  relevant: number; // logged as opportunities
  invitations: number; // relevant AND category === "Invitation" (alerted)
  irrelevant: number;
  failed: number; // analyzer returned null
  deferred: number; // left for the next run (per-run cap reached)
  query: string; // the Gmail query used (for visibility)
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
    irrelevant: 0,
    failed: 0,
    deferred: 0,
    query,
  };

  // One hit per thread (conversation), newest first — collapses reply chains,
  // calendar invites and reminders into a single tracked opportunity.
  const threads = await searchThreads(auth, query);
  const processed = await getProcessedThreadIds(auth);

  let analyzed = 0;
  for (const { threadId, latestMessageId } of threads) {
    if (processed.has(threadId)) {
      result.skipped++;
      continue;
    }
    // Per-run cap: defer the rest to the next hourly run.
    if (analyzed >= config.ingest.maxPerRun) {
      result.deferred++;
      continue;
    }
    if (analyzed > 0) await sleep(config.ingest.throttleMs);
    analyzed++;
    result.scanned++;

    const message = await fetchMessage(auth, latestMessageId);
    if (!message) {
      result.failed++;
      continue;
    }

    const analysis = await analyzer.analyze({
      subject: message.subject,
      body: message.body,
      emailDate: message.date,
    });

    if (!analysis) {
      // Don't mark processed — let the next run retry transient failures.
      result.failed++;
      continue;
    }

    if (analysis.is_relevant) {
      await appendRow(auth, {
        received: message.date,
        company: analysis.company,
        role: analysis.role,
        type: analysis.type,
        category: analysis.category,
        interviewDateTime: analysis.interview_datetime ?? "",
        summary: analysis.summary,
        status: analysis.category === "Rejection" ? "Rejected" : "Review Needed",
        threadId,
      });
      // Alert ONLY for genuine invitations — not acknowledgements/rejections.
      if (analysis.category === "Invitation") {
        await notifyNewOpportunity(auth, message.subject, analysis);
        result.invitations++;
      }
      result.relevant++;
    } else {
      result.irrelevant++;
    }

    // Mark the thread processed (relevant or not) — kept off the visible tab.
    await markProcessed(auth, threadId);
  }

  // Advance the watermark only when fully caught up — anything deferred or
  // failed is older (we scan newest first), so leaving the watermark put keeps
  // those items inside the next run's `after:` window until they're handled.
  if (result.deferred === 0 && result.failed === 0) {
    await setLastChecked(auth, runStartedEpoch);
  }

  return result;
}

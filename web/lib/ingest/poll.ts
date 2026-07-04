/**
 * Ingestion orchestration: Gmail search → dedup → AI classify → Sheet + notify.
 * Invoked by /api/cron/poll. See docs/ArchitectureLite.md §2.
 *
 * Rules-first: templated acknowledgements and rejections are classified for free
 * by heuristics (no LLM call); mail with real interview/recruiter signal goes to the
 * model (Gemini free tier by default) for company, category, step and interview time.
 * Positions are keyed on the normalized company NAME so a company's ack/interview/
 * rejection group together even across different sender domains (ATS vs corporate).
 */
import { makeAuthedClient } from "@/lib/google/auth";
import { searchMessages, fetchMessage } from "@/lib/google/gmail";
import {
  appendRows,
  ensureSheets,
  getLastChecked,
  getProcessedIds,
  markProcessedBatch,
  setLastChecked,
  type NewJobRow,
  type ProcessedEntry,
} from "@/lib/google/sheets";
import { notifyDigest, type AlertItem } from "@/lib/notify";
import { config } from "@/lib/config";
import type { EmailAnalyzer } from "@/lib/ai/analyzer";
import { getAnalyzer } from "@/lib/ai";
import { classifyHeuristically, looksLikeInvitation } from "@/lib/classify/heuristics";

export interface PollResult {
  scanned: number; // messages handled this run (rule + ai)
  skipped: number; // already processed, or our own digest email
  relevant: number; // logged
  invitations: number; // relevant AND category === "Invitation"
  offers: number; // relevant AND category === "Offer"
  ruleClassified: number; // acks/rejections handled for free (no AI call)
  aiCalls: number; // Gemini calls made (counts against the daily free quota)
  irrelevant: number; // not job-related (model said so, or rule-skipped as noise)
  failed: number; // analyzer returned null (transient — retried next run)
  deferred: number; // left for the next run (AI budget reached)
  query: string;
}

/** Stable position key from the company name (domain fallback if unknown). */
function companyKeyFor(company: string, domain: string): string {
  const slug = (company || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  if (slug && slug !== "unknown") return slug;
  return (domain || "").toLowerCase().trim() || "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-query a little before the watermark so nothing slips through the boundary;
// the Processed-ID set prevents double-processing the overlap.
const OVERLAP_SECONDS = 600;

export async function runPoll(analyzer: EmailAnalyzer = getAnalyzer()): Promise<PollResult> {
  const auth = makeAuthedClient();
  await ensureSheets(auth);

  // Delta scanning: only mail since the last successful run (else the start date).
  const lastChecked = await getLastChecked(auth);
  const timeBound =
    lastChecked != null
      ? `after:${Math.max(0, lastChecked - OVERLAP_SECONDS)}`
      : `after:${config.ingest.startDate}`;
  // Exclude our own digest emails: they land in this same inbox and match the
  // keyword query, so without this they'd be re-ingested as new "invitations"
  // and trigger another digest — an hourly self-notification loop.
  const query = `${config.ingest.searchQuery} ${timeBound} -from:me`;
  const runStartedEpoch = Math.floor(Date.now() / 1000);

  const result: PollResult = {
    scanned: 0,
    skipped: 0,
    relevant: 0,
    invitations: 0,
    offers: 0,
    ruleClassified: 0,
    aiCalls: 0,
    irrelevant: 0,
    failed: 0,
    deferred: 0,
    query,
  };

  // Every matching message counts — interview invites often arrive as replies
  // inside an already-tracked conversation, so we track per MESSAGE, not thread.
  const messages = await searchMessages(auth, query);
  const processed = await getProcessedIds(auth);

  // Batch writes + alerts; flush once at the end (Sheets write-quota friendly).
  const rowsToAppend: NewJobRow[] = [];
  const processedIds: ProcessedEntry[] = [];
  const alerts: AlertItem[] = [];

  for (const { messageId, threadId } of messages) {
    if (processed.messageIds.has(messageId)) {
      result.skipped++;
      continue;
    }
    const message = await fetchMessage(auth, messageId);
    if (!message) {
      result.failed++;
      continue;
    }

    // Legacy compat: a v1 marker means the whole thread was settled up to the
    // watermark under the old one-row-per-thread scheme. Suppress only mail
    // from before that watermark (the overlap window can re-surface it);
    // NEWER replies in the same thread must be analyzed. Don't mark these
    // processed — the backfill script decides what to do with them.
    if (processed.legacyThreadIds.has(threadId)) {
      const messageEpoch = Math.floor(new Date(message.date).getTime() / 1000);
      if (messageEpoch <= (lastChecked ?? 0)) {
        result.skipped++;
        continue;
      }
    }

    // Backstop for the self-notification loop (in case -from:me misses it, e.g.
    // an alias/forward): never analyze or alert on our own digests — just record
    // the message as processed so it's not re-scanned. MUST stay ahead of any
    // classification below so our own alerts never reach the rules or the AI.
    if (message.isSelfNotification) {
      result.skipped++;
      processedIds.push({ messageId, threadId });
      continue;
    }

    // Rules-first: acks/rejections are classified for free (no LLM call, no
    // throttle). Only mail with real interview/recruiter signal costs an AI call.
    let analysis = classifyHeuristically(message);
    let source = "rule";
    if (analysis) {
      result.ruleClassified++;
    } else {
      // Not an ack/rejection. Skip broad-query noise (newsletters etc.) for free
      // so it never burns the daily AI budget; only signal-bearing mail hits AI.
      if (!looksLikeInvitation(message)) {
        result.irrelevant++;
        processedIds.push({ messageId, threadId }); // settled → don't refetch it
        continue;
      }
      // Needs AI, but the free quota is finite — defer once it's spent this run.
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
        senderName: message.senderName,
        senderDomain: message.senderDomain,
        links: message.links,
      });
      if (!analysis) {
        result.failed++;
        continue; // transient failure → retry next run (not marked processed)
      }
    }

    result.scanned++;

    if (analysis.is_relevant) {
      const companyKey = companyKeyFor(analysis.company, message.senderDomain);
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
        link: analysis.apply_url ?? "",
        interviewer: analysis.interviewer_name ?? "",
        messageId,
      });
      // Interviews and offers are action-worthy → bundle into the digest.
      if (analysis.category === "Invitation" || analysis.category === "Offer") {
        alerts.push({
          company: analysis.company,
          companyKey,
          role: analysis.role,
          step: analysis.step,
          category: analysis.category,
          interviewDateTime: analysis.interview_datetime ?? "",
          summary: analysis.summary,
          received: message.date,
          threadId,
        });
        if (analysis.category === "Invitation") result.invitations++;
        else result.offers++;
      }
      result.relevant++;
    } else {
      result.irrelevant++;
    }

    processedIds.push({ messageId, threadId });
  }

  // Flush rows first, then processed markers (never mark processed unsaved), then alerts.
  await appendRows(auth, rowsToAppend);
  await markProcessedBatch(auth, processedIds);
  // One grouped digest, rate-limited to one email per window (holds overflow).
  await notifyDigest(auth, alerts);

  // Advance the watermark only when fully caught up.
  if (result.deferred === 0 && result.failed === 0) {
    await setLastChecked(auth, runStartedEpoch);
  }

  return result;
}

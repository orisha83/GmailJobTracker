/**
 * Ingestion orchestration: Gmail search → dedup → AI classify → Sheet + notify.
 * Invoked by /api/cron/poll. See docs/ArchitectureLite.md §2.
 *
 * AI-first: every new conversation is classified by the model (Claude by default),
 * which identifies the hiring company, lifecycle category, step, and interview time.
 * Positions are keyed on the normalized company NAME so a company's ack/interview/
 * rejection group together even across different sender domains (ATS vs corporate).
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
import { notifyDigest, type AlertItem } from "@/lib/notify";
import { config } from "@/lib/config";
import type { EmailAnalyzer } from "@/lib/ai/analyzer";
import { getAnalyzer } from "@/lib/ai";

export interface PollResult {
  scanned: number; // threads analyzed this run
  skipped: number; // already processed
  relevant: number; // logged
  invitations: number; // relevant AND category === "Invitation"
  offers: number; // relevant AND category === "Offer"
  irrelevant: number; // model said not job-related
  failed: number; // analyzer returned null (transient — retried next run)
  deferred: number; // left for the next run (per-run cap reached)
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
    irrelevant: 0,
    failed: 0,
    deferred: 0,
    query,
  };

  // One hit per thread (conversation), newest first.
  const threads = await searchThreads(auth, query);
  const processed = await getProcessedThreadIds(auth);

  // Batch writes + alerts; flush once at the end (Sheets write-quota friendly).
  const rowsToAppend: NewJobRow[] = [];
  const processedIds: string[] = [];
  const alerts: AlertItem[] = [];

  for (const { threadId, latestMessageId } of threads) {
    if (processed.has(threadId)) {
      result.skipped++;
      continue;
    }
    if (result.scanned >= config.ingest.maxPerRun) {
      result.deferred++;
      continue; // not marked processed → handled next run
    }

    const message = await fetchMessage(auth, latestMessageId);
    if (!message) {
      result.failed++;
      continue;
    }

    // Backstop for the self-notification loop (in case -from:me misses it, e.g.
    // an alias/forward): never analyze or alert on our own digests — just record
    // the thread as processed so it's not re-scanned.
    if (message.isSelfNotification) {
      result.skipped++;
      processedIds.push(threadId);
      continue;
    }

    if (result.scanned > 0) await sleep(config.ingest.throttleMs);
    result.scanned++;

    const analysis = await analyzer.analyze({
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
        source: "ai",
        threadId,
        link: analysis.apply_url ?? "",
        interviewer: analysis.interviewer_name ?? "",
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

    processedIds.push(threadId);
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

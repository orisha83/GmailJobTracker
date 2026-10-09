/**
 * Rescan: recover past mail the tracker never logged. Walks Gmail over a date
 * range with the normal search query and runs the CURRENT pipeline (rules →
 * noise gate → AI + offer guard) on every message that has no Tracker row —
 * whether it was dropped as noise by an older classifier, or predates the
 * tracker's start date. Relevant mail is appended (snapped onto companies
 * already tracked); nothing existing is modified, and no digest is sent.
 *
 * Dry run (default) writes nothing and spends no AI calls: it reports what the
 * rules settle for free and lists what would go to the AI.
 *
 * Resumable: `cursor` = "<pageToken>|<index>"; when the AI budget is spent the
 * report returns done=false and the cursor to continue from.
 */
import { makeAuthedClient } from "@/lib/google/auth";
import { fetchMessage, searchMessagesPage } from "@/lib/google/gmail";
import {
  appendRawEmails,
  appendRows,
  ensureSheets,
  markProcessedBatch,
  readRawEmails,
  readRawSenderDomains,
  readRows,
  type NewJobRow,
  type ProcessedEntry,
  type RawEmail,
} from "@/lib/google/sheets";
import { classifyHeuristically, looksLikeApplicationMail } from "@/lib/classify/heuristics";
import { guardOfferDowngrade, stripSelfInterviewer, type EmailAnalyzer } from "@/lib/ai/analyzer";
import { getAnalyzer } from "@/lib/ai";
import { groupKeyFor, knownCompanies, snapToKnown } from "@/lib/company";
import { config } from "@/lib/config";
import { collectSentSubmissions } from "@/lib/ingest/sent";

export interface RescanItem {
  date: string;
  company: string;
  category: string;
  source: "rule" | "ai" | "sent";
  subject: string;
}

export interface RescanReport {
  searched: number; // messages listed by the search
  alreadyTracked: number; // have a Tracker row — untouched
  added: RescanItem[]; // relevant mail recovered (appended unless dry run)
  needsAi: { date: string; from: string; subject: string }[]; // dry run only
  noise: number; // rules/gate/AI say not job mail
  duplicates: number; // identical re-sends of mail recovered in this run
  aiCalls: number;
  failed: number;
  applied: boolean;
  done: boolean;
  cursor?: string; // continue from here when done=false
}

// A history walk fetches hundreds of messages back to back; spacing them keeps
// well inside Gmail's "query cost per minute per user" limit.
const FETCH_GAP_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function emptyReport(dryRun: boolean): RescanReport {
  return {
    searched: 0,
    alreadyTracked: 0,
    added: [],
    needsAi: [],
    noise: 0,
    duplicates: 0,
    aiCalls: 0,
    failed: 0,
    applied: !dryRun,
    done: true,
  };
}

/** "YYYY-MM-DD" or "YYYY/MM/DD" → Gmail's "YYYY/MM/DD". */
function gmailDate(d: string): string {
  const m = (d || "").match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) throw new Error(`Invalid date "${d}" — use YYYY-MM-DD`);
  return `${m[1]}/${m[2]}/${m[3]}`;
}

/**
 * `sent: true` walks YOUR sent mail instead: home-assignment submissions in
 * tracked conversations (or to a tracked company's domain) are logged on
 * their application. Rules only; one invocation covers the whole range.
 */
async function rescanSent(
  opts: { since: string; until?: string; dryRun: boolean },
  report: RescanReport,
): Promise<RescanReport> {
  const auth = makeAuthedClient();
  if (!opts.dryRun) await ensureSheets(auth);
  const rows = await readRows(auth);
  const scan = await collectSentSubmissions(auth, {
    timeBound: `after:${gmailDate(opts.since)}` + (opts.until ? ` before:${gmailDate(opts.until)}` : ""),
    rows,
    senderDomains: await readRawSenderDomains(auth),
    // Only mail that already has a row is settled; replies are re-checked (cheap, rules only).
    processedIds: new Set(rows.map((r) => r.messageId).filter(Boolean)),
    gapMs: FETCH_GAP_MS,
  });
  report.searched = scan.examined;
  report.added = scan.submissions.map((s) => ({ ...s, category: "Progress", source: "sent" as const }));
  if (!opts.dryRun) {
    await appendRows(auth, scan.rows);
    await appendRawEmails(auth, scan.raw);
    await markProcessedBatch(auth, scan.processed);
  }
  return report;
}

export async function runRescan(
  opts: {
    since: string;
    until?: string;
    dryRun?: boolean;
    limit?: number;
    cursor?: string;
    maxPages?: number;
    sent?: boolean;
  },
  analyzer: EmailAnalyzer = getAnalyzer(),
): Promise<RescanReport> {
  const dryRun = opts.dryRun ?? true;
  const limit = opts.limit ?? config.ingest.maxPerRun;
  const maxPages = opts.maxPages ?? 1; // bounds Gmail fetches per invocation (≈25s at the fetch gap)
  const query =
    `${config.ingest.searchQuery} after:${gmailDate(opts.since)}` +
    (opts.until ? ` before:${gmailDate(opts.until)}` : "") +
    " -from:me";

  if (opts.sent) {
    gmailDate(opts.since); // validate before any I/O
    return rescanSent({ since: opts.since, until: opts.until, dryRun }, emptyReport(dryRun));
  }

  const auth = makeAuthedClient();
  if (!dryRun) await ensureSheets(auth);
  const rows = await readRows(auth);
  const known = knownCompanies(rows);
  const trackedIds = new Set(rows.map((r) => r.messageId).filter(Boolean));
  // Pre-migration rows have no messageId: match them by thread + received day.
  const legacy = new Set(rows.filter((r) => !r.messageId).map((r) => `${r.threadId}|${r.received.slice(0, 10)}`));

  const report = emptyReport(dryRun);
  // ATS systems re-send identical acks (one apply → 6 copies); keep one —
  // across runs too, so a second rescan never adds the copies it skipped.
  const dupKeyOf = (key: string, category: string, subject: string, received: string) =>
    `${key}|${category}|${subject.trim()}|${received.slice(0, 10)}`;
  const raw = await readRawEmails(auth);
  const seen = new Set<string>();
  for (const r of rows) {
    const subject = raw.get(r.messageId)?.subject;
    if (subject) seen.add(dupKeyOf(groupKeyFor(r), r.category, subject, r.received));
  }
  const newRows: NewJobRow[] = [];
  const rawToAppend: RawEmail[] = [];
  const processedIds: ProcessedEntry[] = [];

  const [tokenPart, indexPart] = (opts.cursor ?? "|0").split("|");
  let pageToken: string | undefined = tokenPart || undefined;
  let index = Number(indexPart) || 0;

  pages: for (let page = 0; page < maxPages; page++) {
    const { hits, nextPageToken } = await searchMessagesPage(auth, query, pageToken);
    for (; index < hits.length; index++) {
      const { messageId, threadId } = hits[index];
      report.searched++;
      if (trackedIds.has(messageId)) {
        report.alreadyTracked++;
        continue;
      }
      await sleep(FETCH_GAP_MS); // Gmail's per-user per-minute query budget is small
      const message = await fetchMessage(auth, messageId);
      if (!message) {
        report.failed++;
        continue;
      }
      if (legacy.has(`${threadId}|${message.date.slice(0, 10)}`)) {
        report.alreadyTracked++;
        continue;
      }
      if (message.isSelfNotification) continue;

      let analysis = classifyHeuristically(message);
      let source: "rule" | "ai" = "rule";
      if (!analysis) {
        if (!looksLikeApplicationMail(message)) {
          report.noise++;
          continue;
        }
        if (dryRun) {
          report.needsAi.push({
            date: message.date.slice(0, 10),
            from: `${message.senderName} <${message.senderDomain}>`,
            subject: message.subject,
          });
          continue;
        }
        if (report.aiCalls >= limit) {
          report.done = false;
          report.cursor = `${pageToken ?? ""}|${index}`;
          break pages; // resume at THIS message
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
          report.failed++; // quota/safety — a later rescan retries it
          continue;
        }
        analysis = guardOfferDowngrade(analysis, `${message.subject}\n${message.body}`);
        analysis = stripSelfInterviewer(analysis, config.ingest.candidateName);
      }
      if (!analysis.is_relevant) {
        report.noise++;
        continue;
      }

      const { company, companyKey } = snapToKnown(analysis.company, message, known);
      const dupKey = dupKeyOf(companyKey, analysis.category, message.subject, message.date);
      if (seen.has(dupKey)) {
        report.duplicates++;
        continue;
      }
      seen.add(dupKey);
      if (!known.some((k) => k.key === companyKey)) known.push({ key: companyKey, name: company });
      trackedIds.add(messageId);
      report.added.push({
        date: message.date.slice(0, 10),
        company,
        category: analysis.category,
        source,
        subject: message.subject,
      });
      newRows.push({
        received: message.date,
        company,
        companyKey,
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
      processedIds.push({ messageId, threadId });
    }
    index = 0;
    if (!nextPageToken) break;
    pageToken = nextPageToken;
    if (page === maxPages - 1) {
      report.done = false;
      report.cursor = `${pageToken}|0`;
    }
  }

  if (!dryRun) {
    // Rows and raw first, processed markers last (never mark unsaved work).
    await appendRows(auth, newRows);
    await appendRawEmails(auth, rawToAppend);
    await markProcessedBatch(auth, processedIds);
  }
  return report;
}

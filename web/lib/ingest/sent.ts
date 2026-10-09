/**
 * The candidate's SENT mail: log home-assignment submissions on the
 * application they belong to, so "Home assignment" moves on to "Assignment
 * submitted · <date>". Everything else you send (scheduling replies, nudges)
 * is ignored. Rules only — no AI calls, no digest alerts.
 *
 * A sent message belongs to an application when it's in a TRACKED THREAD, or
 * addressed to a TRACKED COMPANY's own domain (a new thread to the recruiter).
 * Mail that matches no application isn't marked processed, so a later rescan
 * can still pick it up once that company is tracked.
 */
import type { OAuth2Client } from "google-auth-library";
import { fetchMessage, searchMessages } from "@/lib/google/gmail";
import type { NewJobRow, ProcessedEntry, RawEmail, TrackedJob } from "@/lib/google/sheets";
import { classifySent } from "@/lib/classify/sent";
import { groupKeyFor, isRelayDomain, knownCompanies, registrableDomain } from "@/lib/company";

export interface SentScan {
  rows: NewJobRow[];
  raw: RawEmail[];
  processed: ProcessedEntry[];
  submissions: { date: string; company: string; subject: string }[];
  examined: number; // sent messages fetched and matched to an application
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function collectSentSubmissions(
  auth: OAuth2Client,
  opts: {
    /** Gmail date clause, e.g. "after:1750000000" or "after:2026/06/01 before:2026/07/01". */
    timeBound: string;
    rows: TrackedJob[];
    /** messageId → sender domain (Raw cache), to learn each company's own domain. */
    senderDomains: Map<string, string>;
    processedIds: Set<string>;
    /** Pause between Gmail fetches (history walks; the hourly poll needs none). */
    gapMs?: number;
  },
): Promise<SentScan> {
  const scan: SentScan = { rows: [], raw: [], processed: [], submissions: [], examined: 0 };

  // Latest row per thread = the application that conversation belongs to.
  const byThread = new Map<string, TrackedJob>();
  for (const r of opts.rows) {
    const cur = byThread.get(r.threadId);
    if (r.threadId && (!cur || (r.received || "") > (cur.received || ""))) byThread.set(r.threadId, r);
  }
  // A company's own (non-ATS, non-freemail) domain → its latest row.
  const byDomain = new Map<string, TrackedJob>();
  for (const r of opts.rows) {
    const d = opts.senderDomains.get(r.messageId);
    if (!d || isRelayDomain(d)) continue;
    const key = registrableDomain(d);
    const cur = byDomain.get(key);
    if (!cur || (r.received || "") > (cur.received || "")) byDomain.set(key, r);
  }

  // Label a submission with its card's name, not the raw label of whichever
  // row happens to be latest in the thread ("mprest.com" → "mPrest").
  const cardName = new Map(knownCompanies(opts.rows).map((k) => [k.key, k.name]));

  const hits = await searchMessages(auth, `in:sent ${opts.timeBound} -to:me`);
  for (const { messageId, threadId } of hits) {
    if (opts.processedIds.has(messageId)) continue;
    const inThread = byThread.get(threadId);
    if (opts.gapMs) await sleep(opts.gapMs);
    const message = await fetchMessage(auth, messageId);
    if (!message || message.isSelfNotification) continue;

    const target =
      inThread ??
      (message.to ?? [])
        .map((a) => byDomain.get(registrableDomain(a.split("@")[1] ?? "")))
        .find(Boolean);
    if (!target) continue; // not about a tracked application (yet)

    const company = cardName.get(groupKeyFor(target)) ?? target.company;
    scan.examined++;
    scan.processed.push({ messageId, threadId });
    const submission = classifySent(message);
    if (!submission) continue; // a reply, not a submission — settled, ignored

    scan.submissions.push({ date: message.date.slice(0, 10), company, subject: message.subject });
    scan.rows.push({
      received: message.date,
      company,
      companyKey: target.companyKey,
      role: target.role,
      step: submission.step,
      category: "Progress",
      interviewDateTime: "",
      summary: submission.summary,
      status: submission.step,
      source: "sent",
      threadId,
      link: "",
      interviewer: "",
      messageId,
    });
    scan.raw.push({
      messageId,
      threadId,
      received: message.date,
      senderName: message.senderName,
      senderDomain: message.senderDomain,
      subject: message.subject,
      body: message.body,
      links: message.links,
    });
  }
  return scan;
}

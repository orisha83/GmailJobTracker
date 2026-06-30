/**
 * Notification digest, sent to the user's own inbox under the same OAuth client.
 *
 * Instead of one email per update (which produced duplicate alerts for the same
 * interview), updates are bundled into a single email — grouped by company and
 * role, showing the bottom line per position (e.g. when the interview is). An
 * hourly gate (config.ingest.notifyMinIntervalMinutes) caps it to one email per
 * window; updates that arrive inside the window are held in the Meta sheet and
 * rolled into the next digest, so nothing is lost.
 */
import type { OAuth2Client } from "google-auth-library";
import { config } from "@/lib/config";
import { sendEmail } from "@/lib/google/gmail";
import { getNotifyState, setNotifyState } from "@/lib/google/sheets";

/** One notify-worthy update (an Invitation or Offer). */
export interface AlertItem {
  company: string;
  companyKey: string;
  role: string;
  step: string;
  category: string;
  interviewDateTime: string;
  summary: string;
  received: string; // email date (ISO)
  threadId: string; // dedup key
}

export type DigestResult = "sent" | "queued" | "noop";

/** Newest first by `received` (falls back to lexical compare, which is fine for ISO). */
function byReceivedDesc(a: AlertItem, b: AlertItem): number {
  return b.received.localeCompare(a.received);
}

/** Builds the plain-text digest body and subject from the merged items. */
function buildDigest(items: AlertItem[]): { subject: string; body: string } {
  // Group by company (stable key), then by role within each company.
  const byCompany = new Map<string, AlertItem[]>();
  for (const it of items) {
    const list = byCompany.get(it.companyKey);
    if (list) list.push(it);
    else byCompany.set(it.companyKey, [it]);
  }

  const sections: string[] = [];
  for (const list of byCompany.values()) {
    const sorted = [...list].sort(byReceivedDesc);
    const companyName = sorted[0].company || "Unknown company";

    const byRole = new Map<string, AlertItem[]>();
    for (const it of sorted) {
      const key = it.role || "(role unspecified)";
      const roleList = byRole.get(key);
      if (roleList) roleList.push(it);
      else byRole.set(key, [it]);
    }

    const lines: string[] = [`■ ${companyName}`];
    for (const [role, roleItems] of byRole) {
      // Bottom line = most recent update for this role.
      const latest = roleItems[0]; // already sorted newest-first
      // Latest known interview time across this role's updates, if any.
      const withTime = roleItems
        .filter((i) => i.interviewDateTime)
        .sort((a, b) => b.interviewDateTime.localeCompare(a.interviewDateTime))[0];

      lines.push(`  • ${role} — ${latest.step || latest.category}`);
      if (withTime) lines.push(`    Interview scheduled for ${withTime.interviewDateTime}`);
      if (latest.summary) lines.push(`    ${latest.summary}`);
    }
    sections.push(lines.join("\n"));
  }

  const companyCount = byCompany.size;
  const subject =
    companyCount === 1
      ? `🚨 Job Agent: Update from ${[...byCompany.values()][0][0].company || "a company"}`
      : `🚨 Job Agent: ${items.length} updates across ${companyCount} companies`;

  const body = `Your job agent has updates on the following ${
    companyCount === 1 ? "position" : "positions"
  }:\n\n${sections.join("\n\n")}\n\nAll updates have been logged in your tracker.`;

  return { subject, body };
}

/**
 * Bundles the run's new alerts with anything held from earlier in the hour and,
 * if the hourly gate is open, sends one grouped email. Otherwise the merged set
 * is persisted for the next run. Returns what happened.
 */
export async function notifyDigest(
  auth: OAuth2Client,
  newItems: AlertItem[],
): Promise<DigestResult> {
  const to = config.ingest.notifyEmail;
  if (!to) return "noop"; // notifications optional

  const { lastNotifiedEpoch, pendingJson } = await getNotifyState(auth);

  let pending: AlertItem[] = [];
  if (pendingJson) {
    try {
      const parsed = JSON.parse(pendingJson);
      if (Array.isArray(parsed)) pending = parsed as AlertItem[];
    } catch {
      pending = []; // tolerate corrupt state
    }
  }

  // Merge + de-dup by threadId (defensive — a thread only alerts once anyway).
  const seen = new Set<string>();
  const merged: AlertItem[] = [];
  for (const it of [...pending, ...newItems]) {
    const key = it.threadId || `${it.companyKey}|${it.role}|${it.received}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(it);
  }

  if (merged.length === 0) return "noop";

  const now = Math.floor(Date.now() / 1000);
  const windowSeconds = config.ingest.notifyMinIntervalMinutes * 60;
  const gateClosed =
    lastNotifiedEpoch != null && now - lastNotifiedEpoch < windowSeconds;

  if (gateClosed) {
    // Hold for the next hour; keep the existing watermark.
    await setNotifyState(auth, lastNotifiedEpoch, JSON.stringify(merged));
    return "queued";
  }

  const { subject, body } = buildDigest(merged);
  await sendEmail(auth, to, subject, body);
  await setNotifyState(auth, now, "[]"); // advance watermark, clear the queue
  return "sent";
}

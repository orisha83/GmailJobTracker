/**
 * Pure position-derivation logic: turns raw Sheet rows (one per email) into
 * dashboard positions. No React, no I/O — unit-tested in positions.test.ts.
 *
 * The position's status is DERIVED from all of its emails (stage-aware), not
 * copied from the latest one: an ack/"under review" arriving after an interview
 * invitation must never drag the position back to "Applied".
 */

// Manual-override options (mirrors PIPELINE_STATUSES in lib/google/sheets.ts).
export const OVERRIDE_STATUSES = [
  "Applied",
  "Interviewing",
  "Offer",
  "Rejected",
  "Withdrawn",
  "Archived",
] as const;

export const STALE_DAYS = 14;

/** One raw Sheet row = one email/round in a conversation. */
export interface Job {
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

/** A derived position = a company + role, built from its email events. */
export interface Position {
  key: string;
  company: string;
  role: string;
  status: string; // stage-aware derived status (or manual override)
  category: string; // category backing the status — drives color
  statusSource: "manual" | "derived";
  summary: string;
  lastUpdate: string;
  nextInterview: string;
  rounds: number;
  stale: boolean;
  latestThreadId: string;
  latestMessageId: string;
  link: string; // best job/careers URL from the position's emails ("" if none)
  interviewer: string; // named interviewer for the upcoming interview ("" if none)
}

export const norm = (s: string) => (s || "").trim().toLowerCase();

// Placeholder roles the model emits when it can't find a title — treat as unknown
// so they fold into the real position instead of splitting off their own card.
const PLACEHOLDER_ROLES = new Set([
  "unknown",
  "n/a",
  "na",
  "none",
  "not specified",
  "unspecified",
  "not specified in the email",
  "not mentioned",
  "—",
  "-",
]);
export const isRealRole = (role: string) => {
  const r = norm(role);
  return r !== "" && !PLACEHOLDER_ROLES.has(r);
};

// Levenshtein distance ≤1 check (used to merge AI spelling variants of one company).
function within1Edit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else {
      i++;
      j++;
    }
  }
  if (i < la || j < lb) edits++;
  return edits <= 1;
}

// Two company keys are the same company if they differ by ≤1 edit (spelling
// variant) or one contains the other ("sweetsecurity" ⊃ "sweetsecure"). The
// length floor keeps short brand prefixes from swallowing distinct companies:
// "papaya" (Papaya Gaming) ⊂ "papayaglobal" (Papaya Global) are DIFFERENT
// employers — merging them let one company's rejection close the other's
// position. Containment only counts when the shorter key is specific enough.
function sameCompany(a: string, b: string): boolean {
  if (a === "unknown" || b === "unknown") return false;
  if (within1Edit(a, b)) return true;
  if (a.length >= 7 && b.length >= 7 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

// Role word-set, used to fold a generic role into a more specific one
// ("Product Manager" ⊂ "Product Manager, Payments").
const roleTokens = (role: string) => new Set(norm(role).split(/[^a-z0-9]+/).filter(Boolean));

const TERMINAL = new Set(["rejection", "offer", "rejected", "withdrawn", "archived"]);
export const isTerminal = (p: { category: string; status: string }) =>
  TERMINAL.has(norm(p.category)) || TERMINAL.has(norm(p.status));

export function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  return isNaN(t) ? 0 : (Date.now() - t) / 86_400_000;
}

// Candidate's timezone — interview wall-clock times are interpreted in this zone.
export const DISPLAY_TZ = "Asia/Jerusalem";

// The model stores interview times as the candidate's local (Asia/Jerusalem)
// wall-clock numerals — but inconsistently tags them (sometimes "Z"). We treat
// the numerals as the source of truth and ignore any timezone designator, so
// the displayed time matches what the candidate was told regardless of viewer tz.
export function wallClockParts(
  s: string,
): { y: number; mo: number; d: number; h: number; mi: number } | null {
  const m = (s || "")
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    y: +m[1],
    mo: +m[2],
    d: +m[3],
    h: +m[4],
    mi: +m[5],
  };
}

/** Comparable value in a single consistent frame (treats wall-clock as UTC). */
export function wallClockMs(s: string): number {
  const p = wallClockParts(s);
  return p ? Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) : NaN;
}

/** "Now" expressed in DISPLAY_TZ wall-clock, in the same UTC-as-frame units as wallClockMs. */
export function nowWallClockMs(): number {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => +(p.find((x) => x.type === t)?.value ?? "0");
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") === 24 ? 0 : g("hour"), g("minute"));
}

/** Earliest upcoming interview time across the rows, or "" if none upcoming. */
function earliestUpcoming(jobs: Job[]): string {
  const now = nowWallClockMs();
  const upcoming = jobs
    .map((j) => ({ s: j.interviewDateTime, t: wallClockMs(j.interviewDateTime) }))
    .filter((x) => !isNaN(x.t) && x.t >= now)
    .sort((a, b) => a.t - b.t);
  return upcoming[0]?.s ?? "";
}

/** Displayed interview: earliest upcoming, else the most recent past one. */
export function pickInterview(jobs: Job[]): string {
  const up = earliestUpcoming(jobs);
  if (up) return up;
  const past = jobs
    .map((j) => ({ s: j.interviewDateTime, t: wallClockMs(j.interviewDateTime) }))
    .filter((x) => !isNaN(x.t))
    .sort((a, b) => b.t - a.t);
  return past[0]?.s ?? "";
}

const REJECTED_STATUS = new Set(["rejected", "withdrawn", "archived"]);
// A rejection (or a manual reject/withdraw/archive) closes a position; any later
// activity begins a fresh one. Offer is deliberately NOT a boundary.
export const isRejectedEvent = (j: { category: string; status: string }) =>
  norm(j.category) === "rejection" || REJECTED_STATUS.has(norm(j.status));

const OVERRIDE_SET = new Set<string>(OVERRIDE_STATUSES.map((s) => s.toLowerCase()));
// Ingestion always initializes status = step and never rewrites it, so a row
// whose status differs from its step (and is one of the dropdown options) was
// edited by the user.
const isManualOverride = (j: Job) =>
  !!j.status && norm(j.status) !== norm(j.step) && OVERRIDE_SET.has(norm(j.status));

/**
 * Stage-aware status for one position segment. Precedence:
 *  1. Rejection email / manual Rejected/Withdrawn/Archived on any row → terminal.
 *  2. Manual override on the LATEST row → it wins. (A newer email creates a
 *     newer row without the override, so newer evidence supersedes it.)
 *  3. Any genuine Offer row → Offer.
 *  4. Any Invitation row → the latest invitation's step. Acks/updates arriving
 *     later can never downgrade an interview stage back to "Applied".
 *  5. An upcoming interview time without an Invitation row → "Interview scheduled".
 *  6. Else the latest row's status/step (ack-only positions → "Applied").
 */
export function derivePositionState(jobs: Job[]): {
  status: string;
  category: string;
  statusSource: "manual" | "derived";
} {
  const byRecent = [...jobs].sort((a, b) => (b.received || "").localeCompare(a.received || ""));
  const latest = byRecent[0];

  const terminal = byRecent.find(isRejectedEvent);
  if (terminal) {
    const status = terminal.status || terminal.step || "Rejected";
    return {
      status,
      category: norm(status) === "rejected" ? "Rejection" : "Other",
      statusSource: isManualOverride(terminal) ? "manual" : "derived",
    };
  }

  if (latest && isManualOverride(latest)) {
    const manualCategory: Record<string, string> = {
      offer: "Offer",
      interviewing: "Invitation",
      applied: "Applied",
    };
    return {
      status: latest.status,
      category: manualCategory[norm(latest.status)] ?? "Other",
      statusSource: "manual",
    };
  }

  const offer = byRecent.find((j) => norm(j.category) === "offer");
  if (offer) {
    return { status: offer.step || "Offer", category: "Offer", statusSource: "derived" };
  }

  const invitation = byRecent.find((j) => norm(j.category) === "invitation");
  if (invitation) {
    return {
      status: invitation.step || "Interview",
      category: "Invitation",
      statusSource: "derived",
    };
  }

  if (earliestUpcoming(jobs)) {
    return { status: "Interview scheduled", category: "Invitation", statusSource: "derived" };
  }

  return {
    status: latest?.status || latest?.step || "Applied",
    category: latest?.category || "Other",
    statusSource: "derived",
  };
}

export function makePosition(company: string, role: string, jobs: Job[]): Position {
  const byRecent = [...jobs].sort((a, b) => (b.received || "").localeCompare(a.received || ""));
  const latest = byRecent[0];
  const lastUpdate = latest?.received || "";
  const nextInterview = pickInterview(jobs);
  const derived = derivePositionState(jobs);
  const pos: Position = {
    // Include the latest thread id so two segments of one company (e.g.
    // applied → rejected → re-applied to the same role) never collide.
    key: `${norm(latest?.companyKey || company)}|${norm(role)}|${latest?.threadId ?? ""}`,
    company,
    role: role || "—",
    status: derived.status,
    category: derived.category,
    statusSource: derived.statusSource,
    summary: latest?.summary || "",
    lastUpdate,
    nextInterview,
    rounds: jobs.length,
    stale: false,
    latestThreadId: latest?.threadId || "",
    latestMessageId: latest?.messageId || "",
    link: byRecent.find((j) => j.link)?.link || "",
    // Prefer the interviewer named on the upcoming interview's email; else the most recent.
    interviewer:
      (nextInterview &&
        jobs.find((j) => j.interviewDateTime === nextInterview && j.interviewer)?.interviewer) ||
      byRecent.find((j) => j.interviewer)?.interviewer ||
      "",
  };
  pos.stale = !isTerminal(pos) && daysSince(lastUpdate) > STALE_DAYS;
  return pos;
}

/** Most frequent non-"Unknown" company name in a group (so a recruiter's
 *  personal name never wins the position label). */
function bestCompanyName(group: Job[]): string {
  const counts = new Map<string, number>();
  for (const j of group) {
    const name = (j.company || "").trim();
    if (!name || name.toLowerCase() === "unknown") continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [name, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = name;
    }
  }
  return best || group.find((j) => j.company?.trim())?.company?.trim() || "Unknown";
}

// A segment's role label = the most-specific real role (largest word-set),
// tie-broken by frequency then recency; "" if the segment has no real title.
function pickSegmentRole(jobs: Job[]): string {
  const real = jobs.filter((j) => isRealRole(j.role));
  if (!real.length) return "";
  const freq = new Map<string, number>();
  for (const j of real) freq.set(norm(j.role), (freq.get(norm(j.role)) ?? 0) + 1);
  return [...real].sort((a, b) => {
    const t = roleTokens(b.role).size - roleTokens(a.role).size;
    if (t) return t;
    const f = (freq.get(norm(b.role)) ?? 0) - (freq.get(norm(a.role)) ?? 0);
    if (f) return f;
    return (b.received || "").localeCompare(a.received || "");
  })[0].role.trim();
}

/** Group events into positions: one card per company, split at each rejection. */
export function buildPositions(jobs: Job[]): Position[] {
  const byCompany = new Map<string, Job[]>();
  for (const j of jobs) {
    const k = norm(j.companyKey) || norm(j.company) || "unknown";
    const arr = byCompany.get(k) ?? [];
    arr.push(j);
    byCompany.set(k, arr);
  }

  // Merge keys that are AI spelling variants of one company (e.g. appflyer ↔
  // appsflyer). Bigger groups win the canonical key; only keys ≥6 chars and
  // within one edit are merged, so distinct short names stay separate.
  const ordered = [...byCompany.entries()].sort((a, b) => b[1].length - a[1].length);
  const merged = new Map<string, Job[]>();
  for (const [key, group] of ordered) {
    let canonical = key;
    if (key !== "unknown") {
      for (const existing of merged.keys()) {
        if (sameCompany(existing, key)) {
          canonical = existing;
          break;
        }
      }
    }
    const arr = merged.get(canonical) ?? [];
    arr.push(...group);
    merged.set(canonical, arr);
  }

  const positions: Position[] = [];
  for (const group of merged.values()) {
    const companyName = bestCompanyName(group);

    // One card per company by default. Walk events oldest→newest and close a
    // segment after each rejection, so activity that arrives after a rejection
    // (a later re-application to the same company) starts a fresh card.
    const chronological = [...group].sort((a, b) =>
      (a.received || "").localeCompare(b.received || ""),
    );
    let segment: Job[] = [];
    for (const j of chronological) {
      segment.push(j);
      if (isRejectedEvent(j)) {
        positions.push(makePosition(companyName, pickSegmentRole(segment), segment));
        segment = [];
      }
    }
    if (segment.length) {
      positions.push(makePosition(companyName, pickSegmentRole(segment), segment));
    }
  }

  // Soonest interview first, then most recent activity.
  return positions.sort((a, b) => {
    const ai = a.nextInterview ? wallClockMs(a.nextInterview) : Infinity;
    const bi = b.nextInterview ? wallClockMs(b.nextInterview) : Infinity;
    if (ai !== bi) return ai - bi;
    return (b.lastUpdate || "").localeCompare(a.lastUpdate || "");
  });
}

export type SortKey = "interview" | "recent" | "company";
export function sortPositions(list: Position[], by: SortKey): Position[] {
  const arr = [...list];
  if (by === "company") return arr.sort((a, b) => a.company.localeCompare(b.company));
  if (by === "recent")
    return arr.sort((a, b) => (b.lastUpdate || "").localeCompare(a.lastUpdate || ""));
  return arr.sort((a, b) => {
    const ai = a.nextInterview ? wallClockMs(a.nextInterview) : Infinity;
    const bi = b.nextInterview ? wallClockMs(b.nextInterview) : Infinity;
    if (ai !== bi) return ai - bi;
    return (b.lastUpdate || "").localeCompare(a.lastUpdate || "");
  });
}

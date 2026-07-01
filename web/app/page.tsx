"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Manual-override options (mirrors PIPELINE_STATUSES in lib/google/sheets.ts).
const OVERRIDE_STATUSES = [
  "Applied",
  "Interviewing",
  "Offer",
  "Rejected",
  "Withdrawn",
  "Archived",
] as const;

const STALE_DAYS = 14;

/** One raw Sheet row = one email/round in a conversation. */
interface Job {
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
}

/** A derived position = a company + role, built from its email events. */
interface Position {
  key: string;
  company: string;
  role: string;
  status: string; // latest email's step (or manual override)
  category: string; // latest email's category — drives color
  summary: string;
  lastUpdate: string;
  nextInterview: string;
  rounds: number;
  stale: boolean;
  latestThreadId: string;
  link: string; // best job/careers URL from the position's emails ("" if none)
  interviewer: string; // named interviewer for the upcoming interview ("" if none)
}

type Filter = "Active" | "Needs attention" | "Rejected" | "All";
const FILTERS: Filter[] = ["Active", "Needs attention", "Rejected", "All"];

const CATEGORY_STYLES: Record<string, string> = {
  Invitation: "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200",
  Applied: "bg-sky-100 text-sky-800 ring-1 ring-sky-200",
  Offer: "bg-violet-100 text-violet-800 ring-1 ring-violet-200",
  Rejection: "bg-rose-100 text-rose-800 ring-1 ring-rose-200",
  Other: "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
};

const norm = (s: string) => (s || "").trim().toLowerCase();
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
const isRealRole = (role: string) => {
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
// variant) or one contains the other (e.g. "papaya" ⊂ "papayaglobal"). The
// length floor keeps short, distinct names from being merged.
function sameCompany(a: string, b: string): boolean {
  if (a === "unknown" || b === "unknown") return false;
  if (within1Edit(a, b)) return true;
  if (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) return true;
  return false;
}
// Role word-set, used to fold a generic role into a more specific one
// ("Product Manager" ⊂ "Product Manager, Payments").
const roleTokens = (role: string) => new Set(norm(role).split(/[^a-z0-9]+/).filter(Boolean));
const TERMINAL = new Set(["rejection", "offer", "rejected", "withdrawn", "archived"]);
const isTerminal = (p: { category: string; status: string }) =>
  TERMINAL.has(norm(p.category)) || TERMINAL.has(norm(p.status));

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// The model stores interview times as the candidate's local (Asia/Jerusalem)
// wall-clock numerals — but inconsistently tags them (sometimes "Z"). We treat
// the numerals as the source of truth and ignore any timezone designator, so
// the displayed time matches what the candidate was told regardless of viewer tz.
function wallClockParts(
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
function wallClockMs(s: string): number {
  const p = wallClockParts(s);
  return p ? Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) : NaN;
}
function fmtInterview(s: string): string {
  if (!s) return "—";
  const p = wallClockParts(s);
  if (!p) return s;
  const ampm = p.h >= 12 ? "PM" : "AM";
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  const mm = String(p.mi).padStart(2, "0");
  return `${MONTHS[p.mo - 1]} ${p.d}, ${p.y}, ${h12}:${mm} ${ampm}`;
}
function fmtDay(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}
function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  return isNaN(t) ? 0 : (Date.now() - t) / 86_400_000;
}

// Candidate's timezone — interview wall-clock times are interpreted in this zone.
const DISPLAY_TZ = "Asia/Jerusalem";
/** "Now" expressed in DISPLAY_TZ wall-clock, in the same UTC-as-frame units as wallClockMs. */
function nowWallClockMs(): number {
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
function pickInterview(jobs: Job[]): string {
  const times = jobs
    .map((j) => j.interviewDateTime)
    .filter(Boolean)
    .map((s) => ({ s, t: wallClockMs(s) }))
    .filter((x) => !isNaN(x.t));
  if (!times.length) return "";
  const now = nowWallClockMs();
  const upcoming = times.filter((x) => x.t >= now).sort((a, b) => a.t - b.t);
  return (upcoming[0] ?? times.sort((a, b) => b.t - a.t)[0]).s;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Google Calendar "create event" link, prefilled from the interview wall-clock
 *  time (1h default), with the company/role as title and the apply link in details.
 *  ctz pins the wall-clock numerals to the candidate's zone. null if no time. */
function calendarUrl(p: Position): string | null {
  const t = wallClockParts(p.nextInterview);
  if (!t) return null;
  const start = `${t.y}${pad2(t.mo)}${pad2(t.d)}T${pad2(t.h)}${pad2(t.mi)}00`;
  const e = new Date(Date.UTC(t.y, t.mo - 1, t.d, t.h + 1, t.mi));
  const end = `${e.getUTCFullYear()}${pad2(e.getUTCMonth() + 1)}${pad2(e.getUTCDate())}T${pad2(e.getUTCHours())}${pad2(e.getUTCMinutes())}00`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${isRealRole(p.role) ? `${p.role} @ ` : "Interview @ "}${p.company}`,
    dates: `${start}/${end}`,
    ctz: DISPLAY_TZ,
  });
  if (p.link) params.set("details", `Link: ${p.link}`);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// Recruiting/scheduling/search hosts whose favicon isn't the hiring company's logo.
const NON_COMPANY_HOST_RE =
  /(greenhouse|lever\.co|myworkday|workday|comeet|workable|ashbyhq|smartrecruiters|bamboohr|teamtailor|calendly|cal\.com|google\.com|docs\.google)/i;
/** Best-guess company domain for a favicon — the apply link's host, unless it's an
 *  ATS/scheduler/search host (then we can't tell, so no logo). */
function companyDomain(p: Position): string | null {
  if (!p.link) return null;
  try {
    const host = new URL(p.link).hostname.replace(/^www\./, "");
    return NON_COMPANY_HOST_RE.test(host) ? null : host;
  } catch {
    return null;
  }
}

type SortKey = "interview" | "recent" | "company";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "interview", label: "Next interview" },
  { key: "recent", label: "Last activity" },
  { key: "company", label: "Company A–Z" },
];
function sortPositions(list: Position[], by: SortKey): Position[] {
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

function makePosition(company: string, role: string, jobs: Job[]): Position {
  const byRecent = [...jobs].sort((a, b) => (b.received || "").localeCompare(a.received || ""));
  const latest = byRecent[0];
  const lastUpdate = latest?.received || "";
  const nextInterview = pickInterview(jobs);
  const pos: Position = {
    // Include the latest thread id so two segments of one company (e.g.
    // applied → rejected → re-applied to the same role) never collide.
    key: `${norm(latest?.companyKey || company)}|${norm(role)}|${latest?.threadId ?? ""}`,
    company,
    role: role || "—",
    status: latest?.status || latest?.step || "Applied",
    category: latest?.category || "Other",
    summary: latest?.summary || "",
    lastUpdate,
    nextInterview,
    rounds: jobs.length,
    stale: false,
    latestThreadId: latest?.threadId || "",
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

const REJECTED_STATUS = new Set(["rejected", "withdrawn", "archived"]);
// A rejection (or a manual reject/withdraw/archive) closes a position; any later
// activity begins a fresh one. Offer is deliberately NOT a boundary.
const isRejectedEvent = (j: { category: string; status: string }) =>
  norm(j.category) === "rejection" || REJECTED_STATUS.has(norm(j.status));

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
function buildPositions(jobs: Job[]): Position[] {
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

export default function Dashboard() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("Active");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("interview");

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setJobs(data.jobs as Job[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const positions = useMemo(() => buildPositions(jobs ?? []), [jobs]);
  const matches = useCallback(
    (p: Position): boolean => {
      switch (filter) {
        case "Active":
          return !isTerminal(p);
        case "Needs attention":
          return p.stale || norm(p.category) === "invitation";
        case "Rejected":
          return norm(p.category) === "rejection" || norm(p.status) === "rejected";
        default:
          return true;
      }
    },
    [filter],
  );
  const counts: Record<Filter, number> = {
    Active: positions.filter((p) => !isTerminal(p)).length,
    "Needs attention": positions.filter((p) => p.stale || norm(p.category) === "invitation").length,
    Rejected: positions.filter(
      (p) => norm(p.category) === "rejection" || norm(p.status) === "rejected",
    ).length,
    All: positions.length,
  };
  const q = norm(query);
  const visible = sortPositions(
    positions
      .filter(matches)
      .filter((p) => !q || norm(p.company).includes(q) || norm(p.role).includes(q)),
    sortBy,
  );

  async function changeStatus(p: Position, status: string) {
    if (!p.latestThreadId) return;
    setSavingKey(p.key);
    // Optimistic: update the latest event's status (drives the position status).
    setJobs((cur) =>
      cur ? cur.map((j) => (j.threadId === p.latestThreadId ? { ...j, status } : j)) : cur,
    );
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(p.latestThreadId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setError("Failed to update status — reloading.");
      await load();
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
            Job Inbox Tracker
          </h1>
          <p className="text-sm text-slate-500">
            Each position, with its current status from the latest email.
          </p>
        </div>
        <button
          onClick={() => load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60"
        >
          {loading && (
            <span
              aria-hidden
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
            />
          )}
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {jobs !== null && positions.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 text-sm shadow-sm">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-3 py-1.5 font-medium transition ${
                filter === f ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {f}{" "}
              <span className={filter === f ? "text-slate-300" : "text-slate-400"}>
                ({counts[f]})
              </span>
            </button>
          ))}
        </div>
      )}

      {jobs !== null && positions.length > 0 && (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search company or role…"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm placeholder:text-slate-400 focus:border-slate-400 focus:outline-none sm:flex-1"
          />
          <label className="flex items-center gap-2 text-sm text-slate-500">
            <span className="hidden sm:inline">Sort</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-700 shadow-sm focus:outline-none sm:w-auto"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {jobs === null && (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          Loading positions…
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {jobs !== null && positions.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="font-medium text-slate-900">No positions tracked yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Application emails will appear here automatically.
          </p>
        </div>
      )}

      {jobs !== null && positions.length > 0 && visible.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
          {q ? (
            <>No matches for “{query}” in “{filter}”.</>
          ) : (
            <>Nothing in “{filter}”. Try another filter.</>
          )}
        </div>
      )}

      {jobs !== null && visible.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm sm:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Company / Position</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Next interview</th>
                  <th className="px-4 py-3">Last update</th>
                  <th className="px-4 py-3">Set status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-800">
                {visible.map((p) => (
                  <tr key={p.key} className="align-top">
                    <td className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <CompanyLogo position={p} />
                        <div>
                          <CompanyName position={p} />
                          <div className="text-slate-500">{p.role}</div>
                          {p.stale && <StaleBadge />}
                          {p.rounds > 1 && (
                            <div className="mt-1 text-xs text-slate-400">{p.rounds} emails</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={p.status} category={p.category} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <NextInterview position={p} />
                      <Interviewer position={p} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-500">
                      {fmtDay(p.lastUpdate)}
                    </td>
                    <td className="px-4 py-3">
                      <OverrideSelect
                        position={p}
                        saving={savingKey === p.key}
                        onChange={changeStatus}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 sm:hidden">
            {visible.map((p) => (
              <div key={p.key} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <CompanyLogo position={p} />
                    <div>
                      <CompanyName position={p} />
                      <div className="text-sm text-slate-500">{p.role}</div>
                    </div>
                  </div>
                  <StatusBadge status={p.status} category={p.category} />
                </div>
                {p.stale && <div className="mt-2"><StaleBadge /></div>}
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
                  {p.nextInterview && (
                    <span className="text-violet-700">
                      📅 <NextInterview position={p} />
                    </span>
                  )}
                  {p.interviewer && (
                    <span>
                      👤{" "}
                      <a
                        href={linkedinUrl(p.interviewer, p.company)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                        title="Find on LinkedIn"
                      >
                        {p.interviewer}
                      </a>
                    </span>
                  )}
                  <span className="text-slate-400">Updated {fmtDay(p.lastUpdate)}</span>
                  {p.rounds > 1 && <span className="text-slate-400">{p.rounds} emails</span>}
                </div>
                <div className="mt-3">
                  <OverrideSelect
                    position={p}
                    saving={savingKey === p.key}
                    onChange={changeStatus}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

const isKnownCompany = (name: string) => {
  const n = norm(name);
  return n !== "" && n !== "unknown";
};
/** Where the company name links to: the extracted job/careers URL, else a
 *  Google "{company} careers" search. */
function companyHref(p: Position): string {
  if (p.link) return p.link;
  return `https://www.google.com/search?q=${encodeURIComponent(`${p.company} careers`)}`;
}

/** Company name — a link to its job/careers page when we can resolve one,
 *  otherwise plain text (e.g. an "Unknown" company with no link). */
function CompanyName({ position }: { position: Position }) {
  if (!position.link && !isKnownCompany(position.company)) {
    return <div className="font-medium text-slate-900">{position.company}</div>;
  }
  return (
    <a
      href={companyHref(position)}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-slate-900 hover:text-slate-950 hover:underline"
      title={position.link || `Search "${position.company} careers"`}
    >
      {position.company}
    </a>
  );
}

/** Company logo via favicon when we can resolve a domain, else a letter avatar. */
function CompanyLogo({ position }: { position: Position }) {
  const [broken, setBroken] = useState(false);
  const domain = companyDomain(position);
  const letter = (position.company || "?").trim().charAt(0).toUpperCase() || "?";
  if (domain && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
        alt=""
        width={20}
        height={20}
        className="mt-0.5 h-5 w-5 shrink-0 rounded"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-slate-200 text-[10px] font-semibold text-slate-600">
      {letter}
    </div>
  );
}

/** Pre-filled LinkedIn people-search for an interviewer (name + company narrows it). */
function linkedinUrl(name: string, company: string): string {
  const kw = [name, company].filter(Boolean).join(" ");
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(kw)}`;
}

/** Named interviewer (when stated) → link to find them on LinkedIn. Renders nothing
 *  when no interviewer was named. */
function Interviewer({ position }: { position: Position }) {
  if (!position.interviewer) return null;
  return (
    <div className="text-slate-500">
      👤{" "}
      <a
        href={linkedinUrl(position.interviewer, position.company)}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:underline"
        title="Find on LinkedIn"
      >
        {position.interviewer}
      </a>
    </div>
  );
}

/** Interview date/time — links to a prefilled Google Calendar event when timed. */
function NextInterview({ position }: { position: Position }) {
  const url = calendarUrl(position);
  const label = fmtInterview(position.nextInterview);
  if (!url) return <>{label}</>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-violet-700 hover:underline"
      title="Add to Google Calendar"
    >
      {label}
    </a>
  );
}

function StatusBadge({ status, category }: { status: string; category: string }) {
  const style = CATEGORY_STYLES[category] ?? CATEGORY_STYLES.Other;
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>
      {status || "—"}
    </span>
  );
}

function StaleBadge() {
  return (
    <span className="mt-1 inline-block whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-amber-200">
      ⏳ No response 2+ weeks — check
    </span>
  );
}

function OverrideSelect({
  position,
  saving,
  onChange,
}: {
  position: Position;
  saving: boolean;
  onChange: (p: Position, status: string) => void;
}) {
  return (
    <select
      aria-label="Set status"
      disabled={saving}
      value=""
      onChange={(e) => e.target.value && onChange(position, e.target.value)}
      className="w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm text-slate-700 disabled:opacity-50 sm:w-auto sm:py-1 sm:text-xs"
    >
      <option value="">Set status…</option>
      {OVERRIDE_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

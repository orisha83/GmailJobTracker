"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  OVERRIDE_STATUSES,
  buildPositions,
  isRealRole,
  isTerminal,
  norm,
  sortPositions,
  wallClockParts,
  DISPLAY_TZ,
  type Job,
  type Position,
  type SortKey,
} from "@/lib/positions";

type Filter = "Active" | "Needs attention" | "Rejected" | "All";
const FILTERS: Filter[] = ["Active", "Needs attention", "Rejected", "All"];

const CATEGORY_STYLES: Record<string, string> = {
  Invitation: "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200",
  Applied: "bg-sky-100 text-sky-800 ring-1 ring-sky-200",
  Offer: "bg-violet-100 text-violet-800 ring-1 ring-violet-200",
  Rejection: "bg-rose-100 text-rose-800 ring-1 ring-rose-200",
  Other: "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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

const SORTS: { key: SortKey; label: string }[] = [
  { key: "interview", label: "Next interview" },
  { key: "recent", label: "Last activity" },
  { key: "company", label: "Company A–Z" },
];

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
    // Initial fetch on mount. load() flips the loading flag synchronously,
    // which this rule flags — intentional for a data-fetch effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // Target the latest email's row by messageId; pre-migration rows have no
    // messageId yet, so fall back to the thread (the API resolves it to the
    // latest row of that thread).
    const id = p.latestMessageId || p.latestThreadId;
    if (!id) return;
    setSavingKey(p.key);
    // Optimistic: update the latest event's row (drives the derived status).
    setJobs((cur) =>
      cur
        ? cur.map((j) =>
            (p.latestMessageId ? j.messageId === p.latestMessageId : j.threadId === p.latestThreadId)
              ? { ...j, status }
              : j,
          )
        : cur,
    );
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`, {
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
            Each position, with its status derived from all of its emails.
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

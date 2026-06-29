"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Mirrors PIPELINE_STATUSES in lib/google/sheets.ts (kept inline so this client
// component doesn't import the server-only googleapis module).
const STATUSES = [
  "Review Needed",
  "Replied",
  "Scheduled",
  "Done",
  "Rejected",
  "Archived",
] as const;
type Status = (typeof STATUSES)[number];

/** One raw Sheet row = one Gmail thread (conversation). */
interface Job {
  rowNumber: number;
  received: string;
  company: string;
  role: string;
  type: string;
  category: string;
  interviewDateTime: string;
  summary: string;
  status: string;
  threadId: string;
}

/** A merged view: one entry per company + real position. */
interface Entry {
  key: string;
  company: string;
  position: string;
  category: string;
  status: string;
  type: string;
  summary: string;
  interview: string;
  received: string;
  count: number;
  threadIds: string[];
}

type Filter = "Invitations" | "All";
const FILTERS: Filter[] = ["Invitations", "All"];

const CATEGORY_STYLES: Record<string, string> = {
  Invitation: "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200",
  Acknowledgement: "bg-sky-100 text-sky-800 ring-1 ring-sky-200",
  Rejection: "bg-rose-100 text-rose-800 ring-1 ring-rose-200",
  Other: "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
};

const STATUS_STYLES: Record<string, string> = {
  "Review Needed": "bg-amber-100 text-amber-900",
  Replied: "bg-blue-100 text-blue-900",
  Scheduled: "bg-violet-100 text-violet-900",
  Done: "bg-emerald-100 text-emerald-900",
  Rejected: "bg-rose-100 text-rose-900",
  Archived: "bg-slate-200 text-slate-700",
};

const norm = (s: string) => (s || "").trim().toLowerCase();
const isRealRole = (role: string) => {
  const r = norm(role);
  return r !== "" && r !== "unknown";
};

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function fmtDay(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function maxReceived(jobs: Job[]): string {
  return jobs.reduce((m, j) => ((j.received || "") > m ? j.received || "" : m), "");
}

/** Soonest upcoming interview time among the threads; else the latest known. */
function pickInterview(jobs: Job[]): string {
  const times = jobs
    .map((j) => j.interviewDateTime)
    .filter(Boolean)
    .map((s) => ({ s, t: new Date(s).getTime() }))
    .filter((x) => !isNaN(x.t));
  if (times.length === 0) return "";
  const now = Date.now();
  const upcoming = times.filter((x) => x.t >= now).sort((a, b) => a.t - b.t);
  if (upcoming.length) return upcoming[0].s;
  return times.sort((a, b) => b.t - a.t)[0].s;
}

function makeEntry(company: string, role: string, jobs: Job[]): Entry {
  const primary = [...jobs].sort((a, b) => (b.received || "").localeCompare(a.received || ""))[0];
  const category = jobs.some((j) => j.category === "Invitation")
    ? "Invitation"
    : jobs.some((j) => j.category === "Acknowledgement")
      ? "Acknowledgement"
      : jobs.some((j) => j.category === "Rejection")
        ? "Rejection"
        : primary?.category || "Other";
  return {
    key: `${norm(company)}|${norm(role)}`,
    company,
    position: role || "—",
    category,
    status: primary?.status || "Review Needed",
    type: primary?.type || "",
    summary: primary?.summary || "",
    interview: pickInterview(jobs),
    received: primary?.received || "",
    count: jobs.length,
    threadIds: jobs.map((j) => j.threadId).filter(Boolean),
  };
}

/**
 * Merge threads into one entry per company + real position. Unknown-role threads
 * fold into the company's (single) real position, or attach to its most-recent
 * position when there are several distinct real roles.
 */
function buildEntries(jobs: Job[]): Entry[] {
  const byCompany = new Map<string, Job[]>();
  for (const j of jobs) {
    const k = norm(j.company) || "unknown";
    const arr = byCompany.get(k) ?? [];
    arr.push(j);
    byCompany.set(k, arr);
  }

  const entries: Entry[] = [];
  for (const group of byCompany.values()) {
    const companyName = group.find((j) => j.company?.trim())?.company?.trim() || "Unknown";
    const realRoles = Array.from(
      new Map(
        group.filter((j) => isRealRole(j.role)).map((j) => [norm(j.role), j.role.trim()]),
      ).values(),
    );

    if (realRoles.length <= 1) {
      entries.push(makeEntry(companyName, realRoles[0] ?? "", group));
      continue;
    }

    const roleBuckets = realRoles.map((role) => ({
      role,
      jobs: group.filter((j) => norm(j.role) === norm(role)),
    }));
    const unknownJobs = group.filter((j) => !isRealRole(j.role));
    if (unknownJobs.length) {
      let target = roleBuckets[0];
      let latest = "";
      for (const b of roleBuckets) {
        const m = maxReceived(b.jobs);
        if (m > latest) {
          latest = m;
          target = b;
        }
      }
      target.jobs.push(...unknownJobs);
    }
    for (const b of roleBuckets) entries.push(makeEntry(companyName, b.role, b.jobs));
  }

  // Soonest upcoming interview first, then most recently received.
  return entries.sort((a, b) => {
    const ai = a.interview ? new Date(a.interview).getTime() : Infinity;
    const bi = b.interview ? new Date(b.interview).getTime() : Infinity;
    if (ai !== bi) return ai - bi;
    return (b.received || "").localeCompare(a.received || "");
  });
}

export default function Dashboard() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("Invitations");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setJobs(data.jobs as Job[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setJobs([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const entries = useMemo(() => buildEntries(jobs ?? []), [jobs]);
  const counts: Record<Filter, number> = {
    Invitations: entries.filter((e) => e.category === "Invitation").length,
    All: entries.length,
  };
  const visible =
    filter === "Invitations" ? entries.filter((e) => e.category === "Invitation") : entries;

  async function changeStatus(entry: Entry, status: Status) {
    setSavingKey(entry.key);
    const ids = new Set(entry.threadIds);
    setJobs((cur) => (cur ? cur.map((j) => (ids.has(j.threadId) ? { ...j, status } : j)) : cur));
    try {
      await Promise.all(
        entry.threadIds.map(async (tid) => {
          const res = await fetch(`/api/jobs/${encodeURIComponent(tid)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }),
      );
    } catch {
      setError("Failed to update status — reloading.");
      await load();
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Job Inbox Tracker</h1>
          <p className="text-sm text-slate-500">
            Interview &amp; recruiter conversations detected from your Gmail.
          </p>
        </div>
        <button
          onClick={() => load()}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
        >
          Refresh
        </button>
      </header>

      {jobs !== null && entries.length > 0 && (
        <div className="mb-4 inline-flex rounded-lg border border-slate-200 bg-white p-1 text-sm shadow-sm">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-3 py-1.5 font-medium transition ${
                filter === f
                  ? "bg-slate-900 text-white"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {f} <span className={filter === f ? "text-slate-300" : "text-slate-400"}>({counts[f]})</span>
            </button>
          ))}
        </div>
      )}

      {jobs === null && (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          Loading opportunities…
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {jobs !== null && entries.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="font-medium text-slate-900">No opportunities tracked yet</p>
          <p className="mt-1 text-sm text-slate-500">
            New interview &amp; recruiter emails will appear here automatically.
          </p>
        </div>
      )}

      {jobs !== null && entries.length > 0 && visible.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="font-medium text-slate-900">No invitations yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Emails inviting you to a call or interview will appear here. Switch to “All” to see
            acknowledgements.
          </p>
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
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Interview</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-800">
                {visible.map((e) => (
                  <tr key={e.key} className="align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{e.company}</div>
                      <div className="text-slate-500">{e.position}</div>
                      {e.summary && <div className="mt-1 text-xs text-slate-400">{e.summary}</div>}
                      {e.count > 1 && (
                        <div className="mt-1 text-xs text-slate-400">{e.count} emails</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <CategoryBadge category={e.category} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{e.type || "—"}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{fmtDate(e.interview)}</td>
                    <td className="px-4 py-3">
                      <StatusControl
                        entry={e}
                        saving={savingKey === e.key}
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
            {visible.map((e) => (
              <div
                key={e.key}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-slate-900">{e.company}</div>
                    <div className="text-sm text-slate-500">{e.position}</div>
                  </div>
                  <CategoryBadge category={e.category} />
                </div>
                {e.summary && <p className="mt-2 text-xs text-slate-400">{e.summary}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
                  <span>{e.type || "—"}</span>
                  {e.interview && (
                    <span className="text-violet-700">📅 {fmtDate(e.interview)}</span>
                  )}
                  {e.count > 1 && <span className="text-slate-400">{e.count} emails</span>}
                </div>
                <div className="mt-3">
                  <StatusControl entry={e} saving={savingKey === e.key} onChange={changeStatus} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const style = CATEGORY_STYLES[category] ?? CATEGORY_STYLES.Other;
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>
      {category || "—"}
    </span>
  );
}

function StatusControl({
  entry,
  saving,
  onChange,
}: {
  entry: Entry;
  saving: boolean;
  onChange: (entry: Entry, status: Status) => void;
}) {
  const style = STATUS_STYLES[entry.status] ?? "bg-slate-100 text-slate-700";
  const known = STATUSES.includes(entry.status as Status);
  return (
    <div className="inline-flex items-center gap-2">
      <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>
        {entry.status || "—"}
      </span>
      <select
        aria-label="Change status"
        disabled={saving}
        value={known ? entry.status : ""}
        onChange={(ev) => onChange(entry, ev.target.value as Status)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 disabled:opacity-50"
      >
        {!known && <option value="">{entry.status || "—"}</option>}
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </div>
  );
}

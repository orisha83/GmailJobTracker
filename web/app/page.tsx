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
const isSubset = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 || a.size > b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
};
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
function fmtDay(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}
function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  return isNaN(t) ? 0 : (Date.now() - t) / 86_400_000;
}

function pickInterview(jobs: Job[]): string {
  const times = jobs
    .map((j) => j.interviewDateTime)
    .filter(Boolean)
    .map((s) => ({ s, t: new Date(s).getTime() }))
    .filter((x) => !isNaN(x.t));
  if (!times.length) return "";
  const now = Date.now();
  const upcoming = times.filter((x) => x.t >= now).sort((a, b) => a.t - b.t);
  return (upcoming[0] ?? times.sort((a, b) => b.t - a.t)[0]).s;
}

function makePosition(company: string, role: string, jobs: Job[]): Position {
  const byRecent = [...jobs].sort((a, b) => (b.received || "").localeCompare(a.received || ""));
  const latest = byRecent[0];
  const lastUpdate = latest?.received || "";
  const pos: Position = {
    key: `${norm(latest?.companyKey || company)}|${norm(role)}`,
    company,
    role: role || "—",
    status: latest?.status || latest?.step || "Applied",
    category: latest?.category || "Other",
    summary: latest?.summary || "",
    lastUpdate,
    nextInterview: pickInterview(jobs),
    rounds: jobs.length,
    stale: false,
    latestThreadId: latest?.threadId || "",
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

/** Group events into positions: by company (+ distinct real role; Unknown folds in). */
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

    // Distinct real roles, most-specific (largest word-set) first, so a generic
    // role ("Product Manager") folds into a specific one ("Product Manager,
    // Payments") rather than splitting into its own card.
    const distinct = Array.from(
      new Map(
        group.filter((j) => isRealRole(j.role)).map((j) => [norm(j.role), j.role.trim()]),
      ).values(),
    ).sort((a, b) => roleTokens(b).size - roleTokens(a).size);

    type Bucket = { role: string; tokens: Set<string>; jobs: Job[] };
    const buckets: Bucket[] = [];
    const labelToBucket = new Map<string, Bucket>();
    for (const role of distinct) {
      const tokens = roleTokens(role);
      let bucket = buckets.find((b) => isSubset(tokens, b.tokens));
      if (!bucket) {
        bucket = { role, tokens, jobs: [] };
        buckets.push(bucket);
      }
      labelToBucket.set(norm(role), bucket);
    }

    if (buckets.length <= 1) {
      positions.push(makePosition(companyName, buckets[0]?.role ?? "", group));
      continue;
    }

    for (const j of group) {
      if (isRealRole(j.role)) labelToBucket.get(norm(j.role))?.jobs.push(j);
    }
    // Fold placeholder-role emails (calendar invites, etc.) into the latest bucket.
    const unknown = group.filter((j) => !isRealRole(j.role));
    if (unknown.length) {
      let target = buckets[0];
      let latest = "";
      for (const b of buckets) {
        const m = b.jobs.reduce((x, j) => ((j.received || "") > x ? j.received || "" : x), "");
        if (m > latest) {
          latest = m;
          target = b;
        }
      }
      target.jobs.push(...unknown);
    }
    for (const b of buckets) positions.push(makePosition(companyName, b.role, b.jobs));
  }

  // Soonest interview first, then most recent activity.
  return positions.sort((a, b) => {
    const ai = a.nextInterview ? new Date(a.nextInterview).getTime() : Infinity;
    const bi = b.nextInterview ? new Date(b.nextInterview).getTime() : Infinity;
    if (ai !== bi) return ai - bi;
    return (b.lastUpdate || "").localeCompare(a.lastUpdate || "");
  });
}

export default function Dashboard() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("Active");

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
  const visible = positions.filter(matches);

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
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Job Inbox Tracker</h1>
          <p className="text-sm text-slate-500">
            Each position, with its current status from the latest email.
          </p>
        </div>
        <button
          onClick={() => load()}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
        >
          Refresh
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
          Nothing in “{filter}”. Try another filter.
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
                      <div className="font-medium text-slate-900">{p.company}</div>
                      <div className="text-slate-500">{p.role}</div>
                      {p.stale && <StaleBadge />}
                      {p.rounds > 1 && (
                        <div className="mt-1 text-xs text-slate-400">{p.rounds} emails</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={p.status} category={p.category} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{fmtDate(p.nextInterview)}</td>
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
                  <div>
                    <div className="font-medium text-slate-900">{p.company}</div>
                    <div className="text-sm text-slate-500">{p.role}</div>
                  </div>
                  <StatusBadge status={p.status} category={p.category} />
                </div>
                {p.stale && <div className="mt-2"><StaleBadge /></div>}
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
                  {p.nextInterview && (
                    <span className="text-violet-700">📅 {fmtDate(p.nextInterview)}</span>
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
      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 disabled:opacity-50"
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

"use client";

/**
 * Manual-correction controls for a position card: merge it into another
 * company, undo a merge, and per-email actions (move to another company,
 * hide, open in Gmail). All edits are written to the Sheet by the dashboard.
 */
import { useState } from "react";
import type { Alias, Job, Position } from "@/lib/positions";

export interface CompanyOption {
  key: string;
  name: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtShort(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso || "—" : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

const CATEGORY_DOT: Record<string, string> = {
  Invitation: "bg-emerald-500",
  Applied: "bg-sky-500",
  Offer: "bg-violet-500",
  Rejection: "bg-rose-500",
};

export const gmailUrl = (j: Job) => `https://mail.google.com/mail/u/0/#all/${j.threadId || j.messageId}`;

const NEW_COMPANY = "__new__";

/** "Merge into…" — folds this card's company into another one (sticky: future
 *  mail for this company lands there too). */
export function MergeSelect({
  position,
  companies,
  disabled,
  onMerge,
}: {
  position: Position;
  companies: CompanyOption[];
  disabled: boolean;
  onMerge: (p: Position, target: CompanyOption) => void;
}) {
  const targets = companies.filter((c) => c.key !== position.groupKey);
  return (
    <select
      aria-label="Merge into another company"
      disabled={disabled || targets.length === 0}
      value=""
      onChange={(e) => {
        const target = targets.find((c) => c.key === e.target.value);
        if (target && confirm(`Merge "${position.company}" into "${target.name}"?`)) {
          onMerge(position, target);
        }
      }}
      className="w-full min-w-0 truncate rounded-md border border-slate-300 bg-white px-2 py-2 text-sm text-slate-700 disabled:opacity-50 sm:w-36 sm:py-1 sm:text-xs"
    >
      <option value="">Merge into…</option>
      {targets.map((c) => (
        <option key={c.key} value={c.key}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

/** Chips for companies merged into this card — × undoes the merge. */
export function MergedChips({
  aliases,
  disabled,
  onUnmerge,
}: {
  aliases: Alias[];
  disabled: boolean;
  onUnmerge: (fromKey: string) => void;
}) {
  if (aliases.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-500">
      <span>Merged:</span>
      {aliases.map((a) => (
        <span
          key={a.fromKey}
          className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2 pr-0.5 ring-1 ring-slate-200"
        >
          {a.fromName || a.fromKey}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onUnmerge(a.fromKey)}
            title="Undo merge"
            aria-label={`Undo merge of ${a.fromName || a.fromKey}`}
            className="flex h-5 w-5 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-50"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

export function EmailsToggle({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="rounded-md px-2 py-2 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-800 sm:py-1 sm:text-xs"
    >
      {open ? "▾" : "▸"} {count} email{count === 1 ? "" : "s"}
    </button>
  );
}

/** The card's emails, newest first, each with move / hide / open actions. */
export function EmailList({
  jobs,
  companies,
  currentKey,
  savingRow,
  onMove,
  onHide,
}: {
  jobs: Job[];
  companies: CompanyOption[];
  currentKey: string;
  savingRow: number | null;
  onMove: (j: Job, company: string) => void;
  onHide: (j: Job) => void;
}) {
  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-slate-50/60">
      {jobs.map((j) => (
        <EmailItem
          key={j.rowNumber ?? j.messageId}
          job={j}
          companies={companies}
          currentKey={currentKey}
          saving={savingRow != null && savingRow === j.rowNumber}
          onMove={onMove}
          onHide={onHide}
        />
      ))}
    </ul>
  );
}

function EmailItem({
  job,
  companies,
  currentKey,
  saving,
  onMove,
  onHide,
}: {
  job: Job;
  companies: CompanyOption[];
  currentKey: string;
  saving: boolean;
  onMove: (j: Job, company: string) => void;
  onHide: (j: Job) => void;
}) {
  const [moving, setMoving] = useState(false);
  const editable = job.rowNumber != null;
  return (
    <li className="flex flex-col gap-2 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full ${CATEGORY_DOT[job.category] ?? "bg-slate-400"}`}
          />
          <span className="font-medium text-slate-800">{job.step || job.category || "—"}</span>
          <span className="text-xs text-slate-400">{fmtShort(job.received)}</span>
          {job.company && <span className="truncate text-xs text-slate-400">· as “{job.company}”</span>}
        </div>
        {job.summary && <p className="mt-0.5 line-clamp-2 text-slate-500">{job.summary}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <a
          href={gmailUrl(job)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md px-2 py-2 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800 sm:py-1"
        >
          Open in Gmail ↗
        </a>
        {editable && (
          <>
            {moving ? (
              <select
                autoFocus
                aria-label="Move this email to company"
                disabled={saving}
                value=""
                onBlur={() => setMoving(false)}
                onChange={(e) => {
                  const v = e.target.value;
                  setMoving(false);
                  if (!v) return;
                  const name =
                    v === NEW_COMPANY
                      ? (prompt("Company name for this email:") ?? "").trim()
                      : (companies.find((c) => c.key === v)?.name ?? "");
                  if (name) onMove(job, name);
                }}
                className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs text-slate-700 sm:py-1"
              >
                <option value="">Move to…</option>
                <option value={NEW_COMPANY}>+ New company…</option>
                {companies
                  .filter((c) => c.key !== currentKey)
                  .map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.name}
                    </option>
                  ))}
              </select>
            ) : (
              <button
                type="button"
                disabled={saving}
                onClick={() => setMoving(true)}
                className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:py-1"
              >
                Move…
              </button>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={() => onHide(job)}
              title="Not job mail / duplicate — remove from the card"
              className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:py-1"
            >
              {saving ? "Saving…" : "Hide"}
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/** Hidden emails, so a hide is never a one-way door. */
export function HiddenList({
  jobs,
  savingRow,
  onUnhide,
}: {
  jobs: Job[];
  savingRow: number | null;
  onUnhide: (j: Job) => void;
}) {
  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
        No hidden emails.
      </div>
    );
  }
  return (
    <>
    <p className="mb-3 text-sm text-slate-500">
      Emails removed from their cards with “Hide” (not job mail, or duplicates). They don’t
      count toward any position’s status. Unhide one to put it back.
    </p>
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">
      {[...jobs]
        .sort((a, b) => (b.received || "").localeCompare(a.received || ""))
        .map((j) => (
          <li
            key={j.rowNumber ?? j.messageId}
            className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <div className="font-medium text-slate-800">
                {j.company || "Unknown"}{" "}
                <span className="font-normal text-slate-500">· {j.step || j.category}</span>
              </div>
              <div className="text-xs text-slate-400">{fmtShort(j.received)}</div>
              {j.summary && <p className="mt-0.5 line-clamp-2 text-slate-500">{j.summary}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <a
                href={gmailUrl(j)}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md px-2 py-2 text-xs text-slate-500 hover:bg-slate-100 sm:py-1"
              >
                Open in Gmail ↗
              </a>
              <button
                type="button"
                disabled={savingRow === j.rowNumber}
                onClick={() => onUnhide(j)}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:py-1"
              >
                {savingRow === j.rowNumber ? "Saving…" : "Unhide"}
              </button>
            </div>
          </li>
        ))}
    </ul>
    </>
  );
}

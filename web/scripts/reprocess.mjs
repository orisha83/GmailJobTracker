// Re-classify tracked emails against the current classifier and show a diff.
// Dry run by default; nothing is written until you pass --apply.
//
//   node --env-file=.env.local scripts/reprocess.mjs             # dry run (diff only)
//   node --env-file=.env.local scripts/reprocess.mjs --apply     # write corrections
//   node --env-file=.env.local scripts/reprocess.mjs --base https://your.app
//
// Talks to /api/admin/reprocess and loops until the whole sheet is covered
// (each invocation is capped by the per-run AI budget).

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const base = args.includes("--base")
  ? args[args.indexOf("--base") + 1]
  : "http://localhost:3000";
const limitArg = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : undefined;

const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("CRON_SECRET is not set (use --env-file=.env.local)");
  process.exit(1);
}

const totals = { rowsExamined: 0, reclassified: 0, aiCalls: 0, backfilledRaw: 0, skippedNoRaw: 0 };
const allChanges = [];
let startRow;
let pass = 0;

for (;;) {
  pass++;
  const res = await fetch(`${base}/api/admin/reprocess`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun: !apply, limit: limitArg, startRow }),
  });
  const report = await res.json();
  if (!res.ok || !report.ok) {
    console.error(`Pass ${pass} failed:`, report.error ?? `HTTP ${res.status}`);
    process.exit(1);
  }

  for (const k of Object.keys(totals)) totals[k] += report[k] ?? 0;
  allChanges.push(...(report.changes ?? []));
  console.log(
    `pass ${pass}: rows ${report.rowsExamined}, AI calls ${report.aiCalls}, changes ${report.changes.length}${report.done ? "" : ` — continuing from row ${report.nextRow}`}`,
  );

  if (report.done) break;
  startRow = report.nextRow;
}

console.log(`\n${apply ? "APPLIED" : "DRY RUN — nothing written (pass --apply to write)"}\n`);
if (allChanges.length === 0) {
  console.log("No corrections needed — every row matches the current classifier.");
} else {
  const w = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
  console.log(`${w("row", 5)} ${w("company", 18)} ${w("role", 24)} ${w("field", 18)} change`);
  for (const c of allChanges) {
    console.log(
      `${w(c.rowNumber, 5)} ${w(c.company, 18)} ${w(c.role, 24)} ${w(c.field, 18)} ${c.oldValue || "—"} → ${c.newValue || "—"}`,
    );
  }
}
console.log(
  `\nTotals: ${totals.rowsExamined} rows, ${totals.reclassified} reclassified, ${totals.aiCalls} AI calls, ` +
    `${totals.backfilledRaw} raw bodies recovered, ${totals.skippedNoRaw} rows unrecoverable, ${allChanges.length} changes.`,
);

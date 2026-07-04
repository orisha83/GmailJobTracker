// One-time repair: recover emails the tracker never analyzed under the old
// one-row-per-thread scheme (interview invites that arrived as replies), and
// migrate existing rows to per-message tracking (MessageID column + Raw cache).
//
//   node --env-file=.env.local scripts/backfill.mjs                  # local dev server
//   node --env-file=.env.local scripts/backfill.mjs --base https://your.app
//
// Loops /api/admin/backfill until every known thread is covered. Safe to
// re-run: already-processed messages are always skipped. Run this BEFORE
// scripts/reprocess.mjs (see the repair runbook in SETUP.md).

const args = process.argv.slice(2);
const base = args.includes("--base")
  ? args[args.indexOf("--base") + 1]
  : "http://localhost:3000";
const limitArg = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : undefined;

const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("CRON_SECRET is not set (use --env-file=.env.local)");
  process.exit(1);
}

const totals = { threadsScanned: 0, messagesSeen: 0, migrated: 0, appended: 0, noise: 0, aiCalls: 0, failed: 0 };
let startIndex;
let pass = 0;

for (;;) {
  pass++;
  const res = await fetch(`${base}/api/admin/backfill`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ limit: limitArg, startIndex }),
  });
  const report = await res.json();
  if (!res.ok || !report.ok) {
    console.error(`Pass ${pass} failed:`, report.error ?? `HTTP ${res.status}`);
    process.exit(1);
  }

  for (const k of Object.keys(totals)) totals[k] += report[k] ?? 0;
  console.log(
    `pass ${pass}: threads ${report.threadsScanned}, unseen messages ${report.messagesSeen}, ` +
      `recovered rows ${report.appended}, migrated ${report.migrated}, AI calls ${report.aiCalls}` +
      (report.done ? "" : ` — continuing from thread #${report.nextIndex}`),
  );

  if (report.done) break;
  startIndex = report.nextIndex;
}

console.log(
  `\nDone. ${totals.threadsScanned} threads scanned, ${totals.messagesSeen} previously-unseen messages: ` +
    `${totals.appended} new rows recovered, ${totals.migrated} rows migrated to per-message tracking, ` +
    `${totals.noise} settled as noise, ${totals.failed} failed (re-run to retry), ${totals.aiCalls} AI calls.`,
);
if (totals.failed > 0) {
  console.log("Some messages failed transiently — run the script again to retry them.");
}
console.log("Next: node --env-file=.env.local scripts/reprocess.mjs   (diff, then --apply)");

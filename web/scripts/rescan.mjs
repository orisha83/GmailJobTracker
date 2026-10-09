// Recover past job mail the tracker never logged (dropped as noise by an older
// classifier, or older than the tracker). Dry run by default — the dry run
// spends no AI calls and lists what the rules settle + what would need the AI.
//
//   node --env-file=.env.local scripts/rescan.mjs --since 2026-06-01            # dry run
//   node --env-file=.env.local scripts/rescan.mjs --since 2026-06-01 --apply    # append rows
//   ... --until 2026-09-01   --base https://your.app   --limit 15
//   ... --sent    # your SENT mail: log home-assignment submissions (rules only)
//
// Loops over /api/admin/rescan until the whole range is covered.

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const apply = args.includes("--apply");
const base = arg("--base") ?? "http://localhost:3000";
const since = arg("--since");
const until = arg("--until");
const limit = arg("--limit") ? Number(arg("--limit")) : undefined;
// --sent: walk YOUR sent mail for home-assignment submissions instead.
const sent = args.includes("--sent");
let cursor = arg("--cursor");

const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("CRON_SECRET is not set (use --env-file=.env.local)");
  process.exit(1);
}
if (!since) {
  console.error("--since YYYY-MM-DD is required");
  process.exit(1);
}

const totals = { searched: 0, alreadyTracked: 0, noise: 0, duplicates: 0, aiCalls: 0, failed: 0 };
const added = [];
const needsAi = [];
let quotaWaits = 0;
for (let pass = 1; ; pass++) {
  const res = await fetch(`${base}/api/admin/rescan`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ since, until, dryRun: !apply, limit, cursor, sent }),
  });
  const report = await res.json();
  // Gmail's per-minute quota: nothing was written for this pass — wait, retry it.
  if (!report.ok && /quota exceeded/i.test(report.error ?? "") && quotaWaits < 5) {
    quotaWaits++;
    console.log("Gmail per-minute quota hit — waiting 65s, then retrying this pass…");
    await new Promise((r) => setTimeout(r, 65_000));
    pass--;
    continue;
  }
  quotaWaits = 0;
  if (!res.ok || !report.ok) {
    console.error(`Pass ${pass} failed:`, report.error ?? `HTTP ${res.status}`);
    if (cursor) console.error(`Resume later with: --cursor "${cursor}"`);
    process.exit(1);
  }
  for (const k of Object.keys(totals)) totals[k] += report[k] ?? 0;
  added.push(...report.added);
  needsAi.push(...report.needsAi);
  console.log(
    `pass ${pass}: searched ${report.searched}, recovered ${report.added.length}, AI calls ${report.aiCalls}` +
      (report.done ? "" : " — continuing"),
  );
  if (report.done) break;
  if (report.cursor === cursor) {
    console.error(`No progress — aborting. Resume later with: --cursor "${cursor}"`);
    break;
  }
  cursor = report.cursor;
}

const w = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
console.log(`\n${apply ? "APPLIED" : "DRY RUN — nothing written (pass --apply to write)"}\n`);
if (added.length) {
  console.log(`Recovered (${added.length}):`);
  for (const a of added.sort((x, y) => x.date.localeCompare(y.date))) {
    console.log(`  ${a.date} ${w(a.category, 10)} ${w(a.company, 26)} [${a.source}] ${a.subject.slice(0, 70)}`);
  }
}
if (needsAi.length) {
  console.log(`\nWould go to the AI (${needsAi.length}) — classified on --apply:`);
  for (const n of needsAi) console.log(`  ${n.date} ${w(n.from, 40)} ${n.subject.slice(0, 70)}`);
}
console.log(
  `\nTotals: ${totals.searched} searched, ${totals.alreadyTracked} already tracked, ${added.length} recovered, ` +
    `${totals.noise} not job mail, ${totals.duplicates} duplicate re-sends, ${totals.aiCalls} AI calls, ${totals.failed} failed.`,
);
if (totals.failed > 0) console.log("Some messages failed (quota?) — re-run later to retry them.");

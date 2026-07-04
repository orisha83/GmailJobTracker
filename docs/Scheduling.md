# Scheduling — hourly, 08:00–20:00 (Asia/Jerusalem)

The ingestion endpoint is `GET /api/cron/poll`, protected by the `CRON_SECRET`
(`Authorization: Bearer <CRON_SECRET>`). It is **safe to call often** — runs only spend Gemini
quota on *new* messages (already-processed message IDs are skipped with no AI call; dedup is
per **message**, so a reply inside a tracked conversation still gets analyzed).

**Free-tier fit:** the default model is `gemini-2.5-flash-lite` (free tier ~1000 requests/day,
15/min). A rules pre-filter classifies templated acknowledgements and rejections for free (no AI
call), so only genuine interview invitations/offers spend quota — a normal day uses a small fraction
of the budget. `MAX_PER_RUN` caps AI calls per run; overflow defers to the next run automatically.
The repair tools (`scripts/backfill.mjs`, `scripts/reprocess.mjs`) use the same per-invocation
budget, so even a full historical repair fits within a day's quota.

**Active schedule:** cron-job.org calls the endpoint **hourly 08:00–20:00 Jerusalem time**.
In **UTC** (Jerusalem is UTC+3 in summer / +2 in winter):
`0 5-17 * * *` → 08:00–20:00 local in summer. (Accept ~1h drift across DST, or adjust the
hours after a clock change — or set the timezone directly in cron-job.org's UI.)

## Activation options (pick one)

### A) Vercel Cron (after deploying) — once/day backup
**Hobby plan caps cron at once per day** (a sub-daily schedule fails to deploy). So `web/vercel.json`
is set to a single daily run (`0 5 * * *` = 08:00 Jerusalem) — a free backup. Vercel automatically
sends the `CRON_SECRET` as a Bearer token. For the actual hourly cadence, use option B
(or upgrade to Pro and restore the multi-hour schedule).

### B) Free external scheduler hitting the deployed URL — free + hourly ← **in use**
Deploy to Vercel (free Hobby for hosting), then have a free scheduler call the endpoint:
- **cron-job.org** (free): GET `https://<your-app>.vercel.app/api/cron/poll`, header
  `Authorization: Bearer <CRON_SECRET>`, hourly 08:00–20:00 (set the timezone in the job).
- or a **GitHub Actions** scheduled workflow doing the same `curl`.

### C) Local macOS cron (runs only while your Mac is on + `npm run dev` is up)
Add to `crontab -e` (uses your local timezone, so use 8–20 directly):
```
0 8-20 * * * curl -s -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/poll >/dev/null 2>&1
```
Good for testing before deploy; not durable (machine/server must be running).

## Notes
- Daily Gemini quota resets at **midnight Pacific**.
- `INGEST_START_DATE` floors the first scan; once a day fully drains, a watermark advances and only
  new mail is scanned thereafter.
- The watermark only advances on a clean run (nothing deferred/failed), and legacy per-thread
  dedup markers suppress only pre-watermark mail — see `docs/ArchitectureLite.md` §2.

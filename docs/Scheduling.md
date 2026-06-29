# Scheduling — every 2 hours, 08:00–20:00 (Asia/Jerusalem)

The ingestion endpoint is `GET /api/cron/poll`, protected by the `CRON_SECRET`
(`Authorization: Bearer <CRON_SECRET>`). It is **safe to call often** — runs only spend Gemini
quota on *new* conversations (already-processed threads are skipped with no AI call).

**Free-tier fit:** Gemini free tier = ~20 requests/day per model. `MAX_PER_RUN=3` × 7 daily runs
(08,10,12,14,16,18,20) ≈ 21 capacity, so a normal day stays within budget; overflow defers to the
next run/day automatically.

Target schedule in **UTC** (Jerusalem is UTC+3 in summer / +2 in winter):
`0 5,7,9,11,13,15,17 * * *` → 08:00–20:00 local. (Accept ~1h drift across DST, or adjust the
hours after a clock change.)

## Activation options (pick one)

### A) Vercel Cron (after deploying) — once/day backup
**Hobby plan caps cron at once per day** (a sub-daily schedule fails to deploy). So `web/vercel.json`
is set to a single daily run (`0 5 * * *` = 08:00 Jerusalem) — a free backup. Vercel automatically
sends the `CRON_SECRET` as a Bearer token. For the actual every-2-hours cadence, use option B
(or upgrade to Pro and restore the multi-hour schedule).

### B) Free external scheduler hitting the deployed URL — free + every 2h
Deploy to Vercel (free Hobby for hosting), then have a free scheduler call the endpoint:
- **cron-job.org** (free): GET `https://<your-app>.vercel.app/api/cron/poll`, header
  `Authorization: Bearer <CRON_SECRET>`, schedule `0 5,7,9,11,13,15,17 * * *` (UTC).
- or a **GitHub Actions** scheduled workflow doing the same `curl`.

### C) Local macOS cron (runs only while your Mac is on + `npm run dev` is up)
Add to `crontab -e` (uses your local timezone, so use 8–20 directly):
```
0 8,10,12,14,16,18,20 * * * curl -s -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/poll >/dev/null 2>&1
```
Good for testing before deploy; not durable (machine/server must be running).

## Notes
- Daily Gemini quota resets at **midnight Pacific**.
- `INGEST_START_DATE` floors the first scan; once a day fully drains, a watermark advances and only
  new mail is scanned thereafter.

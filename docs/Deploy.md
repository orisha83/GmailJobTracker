# Deploy to Vercel + free every-2h cron

Repo: https://github.com/orisha83/GmailJobTracker (private)
The Next.js app lives in **`/web`** (not the repo root) — this matters in step 1.

---

## 1. Import to Vercel
1. https://vercel.com → **Add New… → Project** → **Import** `orisha83/GmailJobTracker`.
2. ⚠️ **Set Root Directory = `web`** (Edit → choose `web`). This is the #1 gotcha — the app is in
   `/web`, not the repo root. Framework auto-detects as **Next.js**.
3. Don't deploy yet — add env vars first (step 2).

## 2. Environment variables (Project → Settings → Environment Variables)
Add each key below for the **Production** environment. Copy the **values from `web/.env.local`**
(don't paste secrets anywhere public):

| Key | Value source |
|---|---|
| `GOOGLE_CLIENT_ID` | from `.env.local` |
| `GOOGLE_CLIENT_SECRET` | from `.env.local` |
| `GOOGLE_REFRESH_TOKEN` | from `.env.local` |
| `SHEET_ID` | from `.env.local` |
| `GEMINI_API_KEY` | from `.env.local` |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` |
| `CRON_SECRET` | from `.env.local` |
| `NOTIFY_EMAIL` | `shalom.ori@gmail.com` |
| `TIMEZONE` | `Asia/Jerusalem` |
| `INGEST_START_DATE` | `2026/06/29` |
| `MAX_PER_RUN` | `3` |
| `APP_BASE_URL` | `https://<your-app>.vercel.app` (fill in after first deploy; optional) |

Then **Deploy**. Note your production URL (e.g. `https://gmail-job-tracker.vercel.app`).

## 3. (Optional) Production OAuth redirect
Only needed if you ever re-connect Google from the deployed app (cron uses the stored refresh
token and does NOT need this). In Google Cloud → Credentials → your OAuth client → Authorized
redirect URIs, add: `https://<your-app>.vercel.app/api/auth/callback`.

## 4. Free external cron — every 2h, 08:00–20:00 (the real scheduler)
Vercel Hobby crons only run once/day, so drive it with a free scheduler instead.

**cron-job.org (recommended):**
1. Sign up at https://cron-job.org → **Create cronjob**.
2. URL: `https://<your-app>.vercel.app/api/cron/poll`
3. Request method: **GET**.
4. Add a header: `Authorization: Bearer <CRON_SECRET>` (same value as the env var).
5. Schedule: set **Timezone = Asia/Jerusalem**, minutes `0`, hours `8,10,12,14,16,18,20`,
   every day.
6. Save & enable.

(Alternative: a GitHub Actions scheduled workflow running the same authenticated `curl`.)

## 5. Verify
- Visit `https://<your-app>.vercel.app` → dashboard loads (light theme, your opportunities).
- Trigger the cron-job.org job manually once → it should return JSON like
  `{"ok":true,"scanned":N,...}`. (Today's Gemini quota may be spent — if so, it'll process on the
  next run after the quota resets at midnight Pacific.)
- Confirm rows appear in your Google Sheet and you get an email only for invitation-type messages.

## Notes
- `web/vercel.json` also declares the schedule; on Hobby it runs ~once/day as a harmless bonus
  (the endpoint is idempotent — thread dedup prevents duplicates). The external cron does the
  every-2h cadence.
- Redeploys happen automatically on every push to `main`.

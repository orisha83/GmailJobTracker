# Self-Host Setup — Gmail Job Tracker

> **This guide is written to be run with [Claude Code](https://claude.com/claude-code).**
> Clone the repo, open it in Claude Code, and say: *"Help me set this up using SETUP.md."*
> Claude will walk you through each step, edit files for you, and verify as it goes.
> You can also follow it by hand — every step is a normal manual action.

The only things **you** must do personally (they need your own logins) are: creating a
Google Cloud project, clicking through Google consent, creating accounts (Vercel, AI
provider, cron), and pasting the secret values you collect. Claude does the rest.

---

## What this app is

A personal job-application tracker. An hourly job scans **your** Gmail for
application/interview/recruiter emails, an AI model classifies each one, and the results
are written to **your** Google Sheet and shown on a dashboard. It optionally emails you a
short digest when something new arrives.

**Architecture (one sentence):** a Next.js app on Vercel + a Google Sheet as the database
+ an external cron pinging one protected endpoint every couple of hours. No server to run,
no database to manage. Costs ~$0 on free tiers.

```
External cron ──Bearer CRON_SECRET──▶ /api/cron/poll ──▶ Gmail (read)
                                            │
                                            ├──▶ AI provider (classify)
                                            ├──▶ Google Sheet (store)
                                            └──▶ Gmail (send you a digest)
   Browser ──▶ /  (dashboard reads the Sheet)
```

---

## Accounts you'll need (all have free tiers)

| Service | Why | Cost |
|---|---|---|
| **Google Cloud** | Gmail + Sheets API access (OAuth) | Free |
| **A Google account** | the inbox to scan + the Sheet to write | Free |
| **AI provider** — Anthropic **or** Google Gemini | classifies each email | Anthropic = paid (cheap, Haiku); Gemini = free tier |
| **Vercel** | hosts the app | Free (Hobby) |
| **cron-job.org** (or GitHub Actions) | triggers the hourly scan | Free |

> **AI provider choice:** the app defaults to **Anthropic Claude Haiku** (`AI_PROVIDER=claude`).
> Haiku is inexpensive but not free. If you want **$0**, set `AI_PROVIDER=gemini` and use a
> free Gemini API key — same features, slightly lower classification quality and a daily
> request cap. You can switch any time by changing one env var.

**Local prerequisite:** Node.js 20+ and npm. Check with `node -v`.

---

## Step 0 — Get the code running locally

```bash
git clone <your-fork-url> GmailJobTracker
cd GmailJobTracker/web
npm install
cp .env.example .env.local      # you'll fill this in as you go
```

> The Next.js app lives in **`/web`**, not the repo root. This matters for Vercel later.

---

## Step 1 — Google Cloud project + APIs

1. Go to https://console.cloud.google.com/ and **create a project** (e.g. "Job Tracker").
2. Enable both APIs in that project:
   - **Gmail API** — https://console.cloud.google.com/apis/library/gmail.googleapis.com
   - **Google Sheets API** — https://console.cloud.google.com/apis/library/sheets.googleapis.com

## Step 2 — OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. User type: **External**. Fill app name + your email for support/developer contact.
3. **Scopes:** leave empty here — the app requests them at runtime
   (`gmail.readonly`, `gmail.send`, `spreadsheets`).
4. **Test users:** add **your own Gmail address**.
5. **Publishing status:** leave as **Testing**.

> The app stays *unverified*, so during sign-in you'll see *"Google hasn't verified this
> app."* That's expected for personal use — click **Advanced → Go to … (unsafe)**.

## Step 3 — OAuth client credentials

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. **Authorized redirect URIs** → add:
   - `http://localhost:3000/api/auth/callback`  (local dev)
   - *(add your Vercel URL later, in Step 8)*
4. Create, then copy the **Client ID** and **Client secret** into `.env.local`:
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

## Step 4 — Create the tracker Google Sheet

1. Create a new, empty Google Sheet **in the same Google account** (any name).
2. Copy its ID from the URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit` → `SHEET_ID`
3. Don't add tabs or headers — the app creates the `Tracker`, `Processed`, `Meta`, and
   `Raw` tabs and the header row automatically on first run.

## Step 5 — AI provider key

**Option A — Google Gemini (default, free):**
1. Get a key at https://aistudio.google.com/app/apikey
2. Set in `.env.local`: `GEMINI_API_KEY=...` (`AI_PROVIDER=gemini` is the default)

**Option B — Anthropic Claude (paid, higher quality):**
1. Get a key at https://console.anthropic.com/ → API Keys → add a few dollars of credit.
2. Set in `.env.local`: `AI_PROVIDER=claude` and `ANTHROPIC_API_KEY=...`

## Step 6 — Finish `.env.local`

Set the remaining values (see the full reference table below):
- `NOTIFY_EMAIL` → your own email (where digests are sent)
- `TIMEZONE` → your IANA timezone, e.g. `America/New_York`, `Europe/London`, `Asia/Jerusalem`
- `CRON_SECRET` → a long random string. Generate one with: `openssl rand -hex 32`
- Leave `GOOGLE_REFRESH_TOKEN` blank for now — you get it in the next step.

## Step 7 — Get your refresh token (via the app)

1. Start the app: `cd web && npm run dev`
2. Visit **http://localhost:3000/api/auth/google**
3. Sign in with the Gmail account you added as a test user, click through the
   "unverified app" screen, and grant access.
4. The callback page shows your **refresh token** — paste it into `.env.local` as
   `GOOGLE_REFRESH_TOKEN`, then restart `npm run dev`.

## Step 8 — Verify locally

1. Visit **http://localhost:3000/api/health** → expect `"configReady": true` with an
   empty `"missingConfig": []`. If anything is listed there, set that env var.
2. Trigger one scan manually:
   ```bash
   curl -H "Authorization: Bearer <YOUR_CRON_SECRET>" http://localhost:3000/api/cron/poll
   ```
   Expect JSON like `{"ok":true,"scanned":N,...}`. Check that rows appear in your Sheet
   and the dashboard at **http://localhost:3000** shows them.

---

## Step 9 — Deploy to Vercel

1. Push your fork to GitHub, then https://vercel.com → **Add New… → Project → Import** it.
2. ⚠️ **Set Root Directory = `web`** (Edit → choose `web`). This is the #1 gotcha — the
   app is in `/web`, not the repo root. Framework auto-detects as **Next.js**.
3. **Settings → Environment Variables:** add every key from your `.env.local` for the
   **Production** environment (see table below). Also set `APP_BASE_URL` to your Vercel URL
   once you know it (e.g. `https://your-app.vercel.app`).
4. **Deploy.** Note your production URL.
5. **Add the production redirect URI:** back in Google Cloud → Credentials → your OAuth
   client → Authorized redirect URIs, add `https://your-app.vercel.app/api/auth/callback`.
   *(Only needed if you ever re-connect Google from the deployed app — cron uses the
   stored refresh token and doesn't need this.)*

## Step 10 — Schedule the scan (external cron)

Vercel Hobby crons only run **once per day** (the daily 05:00 run in `vercel.json` is
just a backstop), so drive the hourly cadence with a free external scheduler.

**cron-job.org (recommended):**
1. Sign up at https://cron-job.org → **Create cronjob**.
2. URL: `https://your-app.vercel.app/api/cron/poll`
3. Method: **GET**.
4. Add header: `Authorization: Bearer <CRON_SECRET>` (the same value as the env var).
5. Schedule: set your timezone, minute `0`, every hour from `8` to `20`, every day.
6. Save & enable. Trigger it once manually to confirm a `{"ok":true,...}` response.

> Alternative: a GitHub Actions scheduled workflow running the same authenticated `curl`.

## Step 11 — Verify production

- Dashboard loads at `https://your-app.vercel.app` and shows your opportunities.
- The manual cron trigger returns `{"ok":true,"scanned":N,...}`.
- Rows appear in your Sheet; you receive a digest email for new invitation-type messages.

✅ Done. Redeploys happen automatically on every push to your default branch.

---

## Full environment variable reference

Set these in `web/.env.local` (local) and in Vercel → Settings → Environment Variables
(production). `.env.local` is gitignored — **never commit real secrets.**

| Key | Required | Default | What it is |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | ✅ | — | OAuth client ID (Step 3) |
| `GOOGLE_CLIENT_SECRET` | ✅ | — | OAuth client secret (Step 3) |
| `GOOGLE_REFRESH_TOKEN` | ✅ | — | Long-lived token from the OAuth flow (Step 7) |
| `GOOGLE_REDIRECT_URI` | — | `APP_BASE_URL`+`/api/auth/callback` | Override only if needed |
| `APP_BASE_URL` | — | `http://localhost:3000` | Your app's base URL; set to the Vercel URL in prod |
| `SHEET_ID` | ✅ | — | Tracker spreadsheet ID (Step 4) |
| `SHEET_DATA_TAB` | — | `Tracker` | Visible data tab name |
| `SHEET_PROCESSED_TAB` | — | `Processed` | Hidden dedup tab |
| `SHEET_META_TAB` | — | `Meta` | Hidden scan-watermark tab |
| `SHEET_RAW_TAB` | — | `Raw` | Hidden raw-email cache (offline re-classification) |
| `AI_PROVIDER` | — | `gemini` | `gemini` (free) or `claude` |
| `ANTHROPIC_API_KEY` | if `claude` | — | Anthropic key (Step 5A) |
| `ANTHROPIC_MODEL` | — | `claude-haiku-4-5` | Anthropic model id |
| `GEMINI_API_KEY` | if `gemini` | — | Gemini key (Step 5B) |
| `GEMINI_MODEL` | — | `gemini-2.5-flash-lite` | Gemini model id |
| `SEARCH_QUERY` | — | bilingual default | Gmail search query for what counts as a job email |
| `TIMEZONE` | — | `Asia/Jerusalem` | IANA tz for date math + dashboard display |
| `INGEST_START_DATE` | — | today (`YYYY/MM/DD`) | First-run scan floor; a watermark takes over after |
| `MAX_PER_RUN` | — | `25` | Max emails analyzed (AI calls) per run — cost/time cap |
| `NOTIFY_EMAIL` | — | — | Where digest emails go (your address) |
| `NOTIFY_MIN_INTERVAL_MINUTES` | — | `60` | Min minutes between digest emails |
| `AI_THROTTLE_MS` | — | `300` | Delay between AI calls |
| `CRON_SECRET` | ✅ | — | Bearer token protecting `/api/cron/poll` |

## Customizing

- **What emails get scanned:** override `SEARCH_QUERY` with any Gmail search expression.
  The default is a broad bilingual (English + Hebrew) keyword filter covering the whole
  application lifecycle. Tell Claude *"narrow the search query to only interview invites"*
  and it'll help.
- **Timezone:** set `TIMEZONE` to your IANA zone. Note: the dashboard currently also has a
  display timezone constant in `web/lib/positions.ts` (`DISPLAY_TZ`) — if your times look
  shifted, ask Claude to align it with your `TIMEZONE`.
- **Quieter notifications:** raise `NOTIFY_MIN_INTERVAL_MINUTES`, or leave `NOTIFY_EMAIL`
  blank to disable digest emails entirely.
- **Cost control:** lower `MAX_PER_RUN`, or use `AI_PROVIDER=gemini` for the free tier.

## Repair / re-classify (no data loss)

Two maintenance scripts fix mistakes **without** wiping the Sheet or your manual
status edits (run them against a local `npm run dev` or with `--base https://your.app`):

1. **Backfill** — one-time after upgrading to per-message tracking, or whenever you
   suspect an email was missed. Walks every known conversation and analyzes messages
   the tracker never saw (e.g. an interview invite that arrived as a reply):
   ```bash
   cd web && node --env-file=.env.local scripts/backfill.mjs
   ```
2. **Reprocess** — re-runs the current classifier over the cached raw emails and
   shows a diff (dry run). Only `--apply` writes the corrections; a Status you set
   by hand is never touched:
   ```bash
   node --env-file=.env.local scripts/reprocess.mjs           # review the diff
   node --env-file=.env.local scripts/reprocess.mjs --apply   # write corrections
   ```

Run backfill first, then reprocess. Both are resumable and safe to re-run; each pass
spends at most `MAX_PER_RUN` AI calls (fits the free Gemini tier).

## Reset / start over

`web/scripts/reset.mjs` clears the Sheet tabs and scan watermark so the next run
re-scans from `INGEST_START_DATE`. **This also wipes manual status edits** — prefer
the repair scripts above. Ask Claude to run it if you want a clean slate.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `/api/health` lists `missingConfig` | That env var isn't set (or is empty) — set it and restart |
| `401 Unauthorized` on `/api/cron/poll` | `Authorization: Bearer <CRON_SECRET>` header missing or mismatched |
| "Google hasn't verified this app" | Expected (Testing mode) — Advanced → Go to … (unsafe) |
| `scanned: 0` every run | Your `SEARCH_QUERY` matches nothing, or `INGEST_START_DATE` is in the future |
| Gemini errors after some runs | Free-tier daily quota spent — resets ~midnight Pacific, or switch to `claude` |
| Vercel build can't find the app | Root Directory isn't set to `web` (Step 9.2) |
| Dashboard times look shifted | Align `DISPLAY_TZ` in `web/app/page.tsx` with your `TIMEZONE` |

---

*Built with Next.js + Google Sheets. See `docs/` for architecture, scheduling, and stack
decisions.*

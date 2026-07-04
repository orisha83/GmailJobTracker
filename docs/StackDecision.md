# Stack Decision — Job Inbox Tracker (MVP)

**Date:** 2026-06-29
**Stage:** 4 — Stack selection
**Status:** Decided

---

## Context
Single-user standalone web app: Google OAuth → poll Gmail → AI extraction → write to Google Sheets → web dashboard to read/edit. Hourly scheduled polling. Free-tier AI. (See [PRD.md](PRD.md).)

## Decision
| Layer | Choice | Why |
|---|---|---|
| **App framework** | **Next.js (App Router) on Vercel** | One deploy for dashboard + API routes + OAuth callback. No separate backend to host. |
| **Scheduler** | **cron-job.org** → hits `/api/cron/poll` hourly 08:00–20:00; Vercel Cron kept as a daily backstop | Vercel Hobby caps cron at once/day, so the hourly cadence comes from a free external scheduler (see [Scheduling.md](Scheduling.md)). |
| **Auth** | **Google OAuth 2.0** via `googleapis` (offline access for refresh token) | Required for Gmail read + Sheets write. |
| **Gmail + Sheets access** | **`googleapis`** (official Google Node client) | One library for Gmail API + Sheets API. |
| **AI extraction** | **Gemini 2.5 Flash** (free tier) behind an `EmailAnalyzer` interface | Free, good at Hebrew, swappable to Claude later. |
| **Data store** | **Google Sheets** (source of truth) | Per PRD — the user's chosen store. |
| **Secret store** | **Vercel environment variables** | Holds OAuth client secret, refresh token, "last checked" marker, Gemini key. Single-user → no DB needed. |
| **Language** | **TypeScript** | Type safety across API routes + Google client. |
| **UI** | React (Next.js) + a light component approach (Tailwind) | Fast MVP, responsive by default. |

## Options considered
1. **Next.js on Vercel + Vercel Cron** ✅ chosen — simplest single deploy, generous free tier.
2. React (Vite) + separate Node/Express backend — cleaner separation but two deploys; unnecessary for a single-user MVP.
3. Next.js run locally — zero hosting but only polls when the machine is on; rejected (we want unattended hourly polling).

## Key technical notes / risks
- **Refresh token + "last checked" marker** live in env/secret (single user). If this ever goes multi-user, this must move to a DB — explicitly out of scope.
- **Gmail is a restricted OAuth scope** → app runs *unverified* with the user as a test user (the "Google hasn't verified this app" screen). Fine for personal use; blocks public launch without Google verification.
- **`EmailAnalyzer` interface** isolates the AI provider so Gemini → Claude is a small change.
- **Vercel Hobby cron is capped at once/day** — the hourly cadence runs on cron-job.org; the cron/admin routes must be protected (secret header / `CRON_SECRET`) so they can't be triggered by outsiders.
- **Sheets concurrency**: single-user + hourly writes → negligible risk. Dashboard status edits and the ingestion job could in theory collide; mitigate by having ingestion only append and never overwrite the status column.

## Required external setup (manual, user-driven)
- Google Cloud project: enable Gmail API + Sheets API, configure OAuth consent screen (External, testing), add user as test user, create OAuth client (web).
- Gemini API key (free tier) from Google AI Studio.
- Vercel project + env vars.

## Next stage
Stage 5 — Architecture-lite (`/architecture-lite`): modules, data flow, API route outline, the `EmailAnalyzer` interface, and the thin-slice build order.

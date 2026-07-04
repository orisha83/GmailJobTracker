# Architecture-Lite — Job Inbox Tracker (MVP)

**Date:** 2026-06-29
**Stage:** 5 — Architecture-lite
**Status:** Draft

Based on [PRD.md](PRD.md) and [StackDecision.md](StackDecision.md). Single-user Next.js app on Vercel: Google OAuth → poll Gmail → Gemini extraction → Google Sheets → dashboard.

---

## 1. Module map
```
/app
  /api
    /auth
      /google            GET  → redirect to Google OAuth consent
      /callback          GET  → exchange code, persist refresh token (secret)
    /cron
      /poll              GET  → hourly ingestion (protected by CRON_SECRET)
    /admin
      /backfill          POST → one-time repair: analyze never-seen messages (CRON_SECRET)
      /reprocess         POST → re-classify cached emails, diff-first (CRON_SECRET)
    /jobs                GET  → read tracked rows from Sheet (dashboard data)
    /jobs/[messageId]    PATCH→ update pipeline status in Sheet
  /(dashboard)
    page.tsx             dashboard UI (table, states, status editor)
/lib
  positions.ts           pure position derivation (grouping, stage-aware status)
  google/
    auth.ts              OAuth client factory, token load/refresh
    gmail.ts             search messages, fetch message, list thread messages
    sheets.ts            rows, raw cache, processed store, batch updates
  ai/
    analyzer.ts          EmailAnalyzer interface + normalize + offer guard
    gemini.ts            Gemini 2.5 Flash Lite implementation (default)
    claude.ts            Claude implementation (optional swap)
  classify/
    heuristics.ts        rule-first ack/rejection classifier + noise gate
  ingest/
    poll.ts              orchestrates: gmail → rules/AI → sheets + notify
    backfill.ts          one-time repair (per-thread era → per-message)
    reprocess.ts         offline re-classification over the Raw cache
  notify.ts              digest email to self
  config.ts              env loading (secrets, sheet id, search query)
/scripts
  reset.mjs              clear all tabs (full re-ingest from start date)
  backfill.mjs           drive /api/admin/backfill until done
  reprocess.mjs          drive /api/admin/reprocess until done (diff → --apply)
```

## 2. Data flow

**Ingestion (hourly cron, 08:00–20:00 via cron-job.org; Vercel daily 05:00 backstop):**
```
/api/cron/poll
  → load OAuth client (refresh token from env)
  → gmail.searchMessages(query + after:watermark-600s − from:me)
      // EVERY matching message, newest first — replies in tracked threads included
  → for each message:
        skip if messageId already processed
        skip (unmarked) if legacy thread marker AND message older than watermark
              // pre-watermark misses belong to scripts/backfill.mjs, not the poller
        skip + mark if self-notification (X-Job-Tracker header backstop)
        rules-first: ack/rejection classified for free (heuristics.ts)
        else noise gate (looksLikeInvitation) → skip + mark for free
        else analyzer.analyze(...)                 // Gemini, budget + throttle
             → guardOfferDowngrade(...)            // "offer you an interview" ≠ Offer
        if is_relevant: queue Tracker row (+ digest alert for Invitation/Offer)
        queue Raw cache entry (subject/body — enables offline re-classification)
        queue processed {messageId, threadId}
  → flush: appendRows → appendRawEmails → markProcessedBatch → notifyDigest
  → advance watermark only on a clean run (no deferred/failed)
```

**Dashboard read:**
```
/(dashboard) → fetch /api/jobs → sheets.readRows() → lib/positions.buildPositions()
  → group rows by company (segments split at rejections)
  → derivePositionState(): terminal → manual-on-latest → Offer → latest
    Invitation step → "Interview scheduled" → Applied   (stage-aware; an ack
    can never downgrade an interview — see PRD §8 derivation table)
```

**Status edit:**
```
status dropdown → PATCH /api/jobs/[id] {status}     // id = messageId (or legacy threadId)
  → sheets.updateStatus(id, status)   // exact row by messageId; threadId falls
                                      // back to that thread's LATEST row.
                                      // Ingestion/reprocess never write Status.
```

**Repair (run once after upgrading to per-message tracking):**
```
scripts/backfill.mjs   → analyze messages the per-thread era never saw,
                         migrate existing rows (MessageID col) + fill Raw cache
scripts/reprocess.mjs  → re-run current classifier over Raw, print diff,
                         --apply writes Step/Category/InterviewDateTime
                         (Status only where the user never edited it)
```

## 3. Google Sheet layout (source of truth)
Visible tab "Tracker": columns A–N per PRD §8 (one row per analyzed email)
`Received | Company | CompanyKey | Role | Step | Category | InterviewDateTime | Summary | Status | Source | ThreadID | Link | Interviewer | MessageID`

Hidden tab "Processed" (A:C): `messageId | threadId | processedAt`. Dedup is per **message** — a reply in a tracked conversation is still new mail. Legacy rows hold a bare threadId in column A (a threadId equals its first message's id) and suppress only pre-watermark mail.

Hidden tab "Raw" (A:H): `MessageID | ThreadID | Received | SenderName | SenderDomain | Subject | Body (4k) | LinksJSON` — offline copy of everything classified, so reprocessing never re-reads Gmail.

Hidden tab "Meta": scan watermark (B1) + notification state (B2:B3).

## 4. The `EmailAnalyzer` interface (swap point)
```ts
type EmailInput = {
  subject: string; body: string; emailDate: string /* ISO */;
  senderName?: string; senderDomain?: string; links?: string[];
};
type Analysis = {
  is_relevant: boolean;
  company: string;                    // English
  role: string;                       // English
  category: "Invitation" | "Applied" | "Rejection" | "Offer" | "Other";
  step: string;                       // "HR screen", "VP interview", ...
  interview_datetime: string | null;  // candidate-local wall-clock, from emailDate
  summary: string;
  apply_url: string;
  interviewer_name: string;
};
interface EmailAnalyzer { analyze(input: EmailInput): Promise<Analysis | null>; }
```
Default implementation: `GeminiAnalyzer` (gemini-2.5-flash-lite, free tier, `responseMimeType: application/json`); `ClaudeAnalyzer` swaps in via `AI_PROVIDER=claude`. Model output passes `normalizeAnalysis` (defensive coercion) and `guardOfferDowngrade` ("Offer" with an interview time but no compensation language → Invitation).

## 5. API outline
| Route | Method | Purpose | Auth |
|---|---|---|---|
| `/api/auth/google` | GET | Start OAuth | none (public) |
| `/api/auth/callback` | GET | Store refresh token | OAuth state |
| `/api/cron/poll` | GET | Hourly ingestion | `CRON_SECRET` header |
| `/api/admin/backfill` | POST | One-time per-message repair | `CRON_SECRET` header |
| `/api/admin/reprocess` | POST | Re-classify cached emails (dry-run default) | `CRON_SECRET` header |
| `/api/jobs` | GET | List tracked rows | session/local |
| `/api/jobs/[messageId]` | PATCH | Update status (messageId, legacy threadId ok) | session/local |

## 6. Secrets / config (env)
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `SHEET_ID`, `GEMINI_API_KEY`, `CRON_SECRET`, `SEARCH_QUERY` (default bilingual), `TIMEZONE` (Asia/Jerusalem), `NOTIFY_EMAIL`, `SHEET_RAW_TAB` (default "Raw").

## 7. Key risks (carried from PRD/Stack)
- Restricted Gmail scope → unverified app + test user.
- Refresh token in env (single-user only).
- Cron + admin routes must verify `CRON_SECRET`.
- Ingestion appends + marks processed only; never writes the Status column → no clobbering manual edits. Reprocess writes Status only where it still equals the old Step (i.e. never user-edited).
- Dedup must stay per **message**: per-thread dedup silently drops interview invites that arrive as replies (the original "stuck on Applied" bug).
- Gemini date parsing → pass `emailDate` + timezone so relative dates resolve.
- Small free-tier model → keep three layers on Offer/Invitation: prompt definition, EN+HE examples, and the code-level `guardOfferDowngrade`.

## 8. Thin-slice build order (each slice shippable)
1. **Project skeleton** — Next.js + TS + Tailwind, env config loader, health route.
2. **OAuth flow** — `/api/auth/google` + `/callback`, obtain & store refresh token; verify Sheets + Gmail access with a smoke read.
3. **Sheets layer** — read rows, append row, processed-ID dedup store, update status.
4. **Analyzer** — `EmailAnalyzer` interface + `GeminiAnalyzer`; unit-test on sample Hebrew/English emails.
5. **Ingestion orchestration** — `/api/cron/poll` wiring gmail→analyzer→sheets + dedup + marker; manual trigger first.
6. **Dashboard** — `/api/jobs` + table UI with loading/empty/error/success states; mobile-friendly.
7. **Status editing** — PATCH route + dropdown.
8. **Notifications** — email-to-self on new relevant opportunity.
9. **Scheduling** — cron-job.org hitting `/api/cron/poll` hourly 08:00–20:00 (Asia/Jerusalem) with the `Authorization: Bearer CRON_SECRET` header; `vercel.json` keeps a daily 05:00 Vercel Cron as backstop (Hobby plan allows daily only).

## 9. Next stage
Stage 6 — Task breakdown (`/implementation-task-breakdown`): turn slices 1–9 into PR-sized tasks, then begin Milestone 0 (skeleton) — which will require installing dependencies and running commands (ask-before).

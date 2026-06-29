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
      /poll              GET  → hourly job (protected by CRON_SECRET)
    /jobs                GET  → read tracked rows from Sheet (dashboard data)
    /jobs/[messageId]    PATCH→ update pipeline status in Sheet
  /(dashboard)
    page.tsx             dashboard UI (table, states, status editor)
/lib
  google/
    auth.ts              OAuth client factory, token load/refresh
    gmail.ts             search + fetch new messages
    sheets.ts            read rows, append rows, update status, dedup store
  ai/
    analyzer.ts          EmailAnalyzer interface + types
    gemini.ts            Gemini 2.5 Flash implementation
  ingest/
    poll.ts              orchestrates: gmail → analyzer → sheets + notify
  notify.ts              send "new opportunity" email to self
  config.ts              env loading (secrets, sheet id, search query)
```

## 2. Data flow

**Ingestion (hourly cron):**
```
/api/cron/poll
  → load OAuth client (refresh token from env)
  → gmail.searchNew(query, sinceMarker)         // bilingual query, newer_than
  → for each new message not in processed-IDs:
        analyzer.analyze({subject, body, emailDate})   // Gemini → JSON
        if is_relevant: sheets.appendRow(...) + notify.sendSelf(...)
        sheets.markProcessed(messageId)          // hidden range, keeps main sheet clean
  → update "last checked" marker (env/secret or a config cell)
```

**Dashboard read:**
```
/(dashboard) → fetch /api/jobs → sheets.readRows() → render table
```

**Status edit:**
```
status dropdown → PATCH /api/jobs/[messageId] {status}
  → sheets.updateStatus(messageId, status)   // never touched by ingestion
```

## 3. Google Sheet layout (source of truth)
Visible sheet "Tracker": columns A–H per PRD §8
`Received | Company | Role | Type | InterviewDateTime | Summary | Status | MessageID`

Hidden sheet "Processed" (or a dedicated column range): one column of processed Gmail message IDs — keeps dedup data out of the visible table (no more "Not Relevant" junk rows).

## 4. The `EmailAnalyzer` interface (swap point)
```ts
type EmailInput = { subject: string; body: string; emailDate: string /* ISO */ };
type Analysis = {
  is_relevant: boolean;
  company: string;
  role: string;
  type: "Interview" | "Phone Call" | "Home Assignment" | "HR Meeting";
  interview_datetime: string | null;  // ISO 8601, resolved using emailDate
  summary: string;
};
interface EmailAnalyzer { analyze(input: EmailInput): Promise<Analysis | null>; }
```
v1 implementation: `GeminiAnalyzer` (gemini-2.5-flash, `responseMimeType: application/json`). Swapping to Claude later = new class implementing the same interface + a config flag.

## 5. API outline
| Route | Method | Purpose | Auth |
|---|---|---|---|
| `/api/auth/google` | GET | Start OAuth | none (public) |
| `/api/auth/callback` | GET | Store refresh token | OAuth state |
| `/api/cron/poll` | GET | Hourly ingestion | `CRON_SECRET` header |
| `/api/jobs` | GET | List tracked rows | session/local |
| `/api/jobs/[messageId]` | PATCH | Update status | session/local |

## 6. Secrets / config (env)
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `SHEET_ID`, `GEMINI_API_KEY`, `CRON_SECRET`, `SEARCH_QUERY` (default bilingual), `TIMEZONE` (Asia/Jerusalem), `NOTIFY_EMAIL`.

## 7. Key risks (carried from PRD/Stack)
- Restricted Gmail scope → unverified app + test user.
- Refresh token in env (single-user only).
- Cron route must verify `CRON_SECRET`.
- Ingestion appends + marks processed only; never writes the Status column → no clobbering manual edits.
- Gemini date parsing → pass `emailDate` + timezone so relative dates resolve.

## 8. Thin-slice build order (each slice shippable)
1. **Project skeleton** — Next.js + TS + Tailwind, env config loader, health route.
2. **OAuth flow** — `/api/auth/google` + `/callback`, obtain & store refresh token; verify Sheets + Gmail access with a smoke read.
3. **Sheets layer** — read rows, append row, processed-ID dedup store, update status.
4. **Analyzer** — `EmailAnalyzer` interface + `GeminiAnalyzer`; unit-test on sample Hebrew/English emails.
5. **Ingestion orchestration** — `/api/cron/poll` wiring gmail→analyzer→sheets + dedup + marker; manual trigger first.
6. **Dashboard** — `/api/jobs` + table UI with loading/empty/error/success states; mobile-friendly.
7. **Status editing** — PATCH route + dropdown.
8. **Notifications** — email-to-self on new relevant opportunity.
9. **Scheduling** — Vercel Cron config hitting `/api/cron/poll` hourly.

## 9. Next stage
Stage 6 — Task breakdown (`/implementation-task-breakdown`): turn slices 1–9 into PR-sized tasks, then begin Milestone 0 (skeleton) — which will require installing dependencies and running commands (ask-before).

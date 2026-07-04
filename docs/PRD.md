# PRD — Job Inbox Tracker (MVP)

**Owner:** Ori Shalom
**Date:** 2026-06-29
**Status:** Draft for review
**Stage:** 1 — Clarify & PRD

---

## 1. Summary
A single-user web app that watches the user's Gmail, uses Claude to detect emails from companies requesting an interview, phone screen, technical/home assignment, or HR conversation, extracts the key details (including any proposed interview date/time), and tracks each opportunity through a pipeline. Google Sheets is the source of truth; a web dashboard reads and updates it.

This replaces and extends an existing Google Apps Script prototype (Gmail search + Gemini analysis + Sheet logging + email notification), turning it into a standalone web app with full Gmail OAuth, Claude-based extraction, date/time capture, and editable pipeline status.

## 2. Problem
Job-seekers receive interview/recruiter emails in Hebrew and English scattered across a busy inbox. Important next-step requests get buried, and there's no single view of where each opportunity stands. Manually logging them into a spreadsheet is tedious and easy to forget.

## 3. Goals
- Automatically surface emails that request an interview / call / assignment / HR chat.
- Extract structured data: company, role, type, proposed date/time, summary.
- Let the user track each opportunity through a simple pipeline without losing their manual edits.
- Keep everything in one Google Sheet the user already trusts.

## 4. Non-goals (explicitly out of scope for MVP)
- Multi-user / sign-ups (single user only).
- Native mobile apps or push notifications.
- Auto-replying to recruiters or scheduling on the user's behalf.
- Auto-creating Google Calendar events (deferred — date/time is captured but not pushed to Calendar in v1).
- Gmail label automation (deferred).
- Google app verification for public distribution (runs unverified, user is a test user).
- Auto-creating the Google Sheet (user points the app at an existing Sheet).

## 5. Target user
A single user (the product owner): an active job-seeker in the Israeli market receiving bilingual (Hebrew/English) recruiting emails.

## 6. Key decisions (locked)
| Decision | Choice |
|---|---|
| Surface | Web app |
| Email ingestion | Full Gmail OAuth + Gmail API (standalone, no Apps Script) |
| Data store | Google Sheets (source of truth) |
| AI provider | Gemini 2.5 Flash Lite (free tier), behind a swappable interface (Claude optional) |
| Users | Single user only |
| Notifications | Email-to-self (v1) |
| Polling frequency | Hourly 08:00–20:00 Asia/Jerusalem via cron-job.org → `/api/cron/poll`; Vercel Cron daily 05:00 as backstop |

## 7. MVP scope (thin vertical slices, in build order)
1. **Auth** — Google OAuth login; user grants Gmail read + Sheets read/write scopes. Refresh token stored securely (secret/env), not in the Sheet.
2. **Ingestion + analysis** — Scheduled backend job searches Gmail with the bilingual query and processes **every new message — including replies inside already-tracked conversations** (an interview invite usually arrives as a reply; per-thread dedup would silently drop it). Rules classify templated acks/rejections for free; signal-bearing mail goes to the AI (Gemini 2.5 Flash Lite behind a swappable interface, plus a code-level offer guard); relevant rows are appended to the Sheet. Dedup by Gmail **message ID**, tracked out of the visible data area. Raw subject/body are cached (hidden tab) so any email can be re-classified offline later.
3. **Dashboard read** — Web table listing tracked positions: company / role / status / next interview / interviewer / last update.
4. **Status editing** — User changes pipeline status from the dashboard; write back to the Sheet without the ingestion job overwriting manual edits.
5. **Scheduling** — Hourly poll (08:00–20:00) so ingestion runs without the user being present.
6. **Notification** — Email-to-self digest when a new invitation or offer is detected.
7. **Repair tools** — `scripts/backfill.mjs` (one-time: recover messages the per-thread era never analyzed) and `scripts/reprocess.mjs` (re-run the current classifier over the raw cache, diff first, then apply — never touching manually-edited statuses).

## 8. Data model (Google Sheet tabs)

**Tracker (visible) — one row per analyzed email, columns A:N**
| Column | Field | Source | Notes |
|---|---|---|---|
| A | Received | Gmail | Email date (ISO 8601) |
| B | Company | AI/rules | Translated to English |
| C | CompanyKey | System | Normalized grouping key (name slug, domain fallback) |
| D | Role | AI/rules | Translated to English |
| E | Step | AI/rules | This email's round, e.g. "HR screen", "VP interview" (immutable record) |
| F | Category | AI/rules | Invitation / Applied / Rejection / Offer / Other — drives color and alerts |
| G | InterviewDateTime | AI | Candidate-local wall-clock, resolved from relative phrases; blank if none |
| H | Summary | AI | 1-sentence English summary |
| I | Status | User/system | Initialized to Step; user-editable; **never overwritten by ingestion or reprocess** |
| J | Source | System | "rule" (free heuristics) or "ai" |
| K | ThreadID | Gmail | Conversation id (one thread → many rows) |
| L | Link | AI | Best job/careers URL from the email |
| M | Interviewer | AI | Named interviewer, if stated |
| N | MessageID | Gmail | **Dedup key — one email = one row** (empty on pre-migration rows until backfill) |

**Processed (hidden) — dedup log, columns A:C:** `messageId | threadId | processedAt`. Legacy rows (bare threadId in A) remain valid: a threadId equals its first message's id, and legacy markers suppress only pre-watermark mail.

**Raw (hidden) — offline email cache, columns A:H:** `MessageID | ThreadID | Received | SenderName | SenderDomain | Subject | Body (truncated 4k) | LinksJSON`. Lets the classifier be re-run without re-reading Gmail.

**Meta (hidden):** scan watermark + notification state.

### Position status — derivation rules (stage-aware)
The dashboard groups rows into positions (company + role, split at rejections) and **derives** the shown status from all of a position's emails, in this precedence:

| # | Situation | Position shows |
|---|-----------|----------------|
| 1 | Any rejection email, or manual Rejected/Withdrawn/Archived | That terminal status (a later re-apply starts a new card) |
| 2 | Manual status set on the **latest** row, no newer email since | The manual status |
| 3 | A genuine job-offer email exists (compensation/contract terms) | Offer |
| 4 | Any interview invitation exists | The most recent invitation's step — a later ack/"under review" can **never** downgrade it to "Applied" |
| 5 | Upcoming interview time exists but no Invitation row (edge case) | "Interview scheduled" |
| 6 | Only acks/updates | Applied |

Manual-override semantics: a manual status holds until **newer email evidence** arrives, then the derived status takes over; terminal manual statuses always stick. Manual dropdown values: `Applied / Interviewing / Offer / Rejected / Withdrawn / Archived`.

"Offer" means employment terms (compensation, contract, offer letter, start date). "We'd like to offer you an interview slot" is an **Invitation** — enforced in the prompts and by a code-level guard (`guardOfferDowngrade`).

## 9. AI extraction contract
The AI provider (Gemini 2.5 Flash Lite for v1, behind an `EmailAnalyzer` interface so Claude/other can be swapped in) receives the email subject, body (truncated), email date, sender hints, and candidate links. Returns JSON:
```json
{
  "is_relevant": true,
  "company": "string (English)",
  "role": "string (English)",
  "category": "Invitation | Applied | Rejection | Offer | Other",
  "step": "short label, e.g. 'HR screen', 'VP interview'",
  "interview_datetime": "candidate-local wall-clock or null",
  "summary": "1-sentence English summary",
  "apply_url": "best job/careers URL from the email links, or empty",
  "interviewer_name": "full name if stated, or empty"
}
```
Model output is normalized defensively (`normalizeAnalysis`) and passed through `guardOfferDowngrade` — an "Offer" carrying an interview time but no compensation language is downgraded to Invitation in code.

## 10. User journeys
1. **First-time setup** — User opens app → signs in with Google → grants Gmail + Sheets access → points app at a Sheet → sees empty dashboard.
2. **Automatic capture** — Hourly (08:00–20:00), the backend finds a new recruiter email — a new thread **or a reply inside a tracked one** — extracts details → the position's derived status updates in the dashboard → invitations/offers land in the digest email.
3. **Triage** — User opens dashboard → sees the position at its interview step with date/time and interviewer → optionally overrides the status from the dropdown.
4. **Review pipeline** — User filters/sorts dashboard to see what needs a reply vs what's scheduled.
5. **Re-auth** — Token expires/revoked → app prompts user to re-connect Google.

## 11. UI states (required)
- **Loading** — fetching Sheet data.
- **Empty** — connected but no opportunities yet ("No opportunities tracked yet — we'll add them as they arrive").
- **Error** — Sheet/Gmail/Claude/API failure with a retry affordance.
- **Success** — table of opportunities with editable status.
- **Mobile width** — usable on a phone browser (responsive table/cards).

## 12. Risks & assumptions
**Risks**
- Gmail read is a *restricted* OAuth scope → unverified-app warning screen; fine for personal test-user use, blocks public launch without verification.
- AI extraction may misclassify or mis-parse dates → keep human-in-the-loop via `Review Needed` default.
- Sheets API has rate/quota limits and is awkward for concurrent writes → low risk at single-user hourly volume.
- Refresh token storage is the one piece not covered by "Sheets only" → store as a secret.
- Gemini free tier: lower rate limits (fine at this volume) and free-tier data may be used by Google to improve models (acceptable for recruiter emails). Swap to Claude later if desired.

**Assumptions**
- Hourly polling during waking hours (08:00–20:00 via cron-job.org) is sufficient; the Vercel daily 05:00 cron is only a backstop.
- One pre-existing Google Sheet, provided by the user.
- Email-to-self notification is enough for v1.
- Same bilingual Gmail search query as the prototype is a good starting filter.

## 13. Open questions
- [ ] Should `interview_datetime` parsing handle time zones explicitly (assume Asia/Jerusalem)?
- [ ] Google Cloud project setup for OAuth consent + Gemini API key (free tier).

## 14. Success criteria (MVP done when)
- User can connect Google and see recruiter emails auto-appear in the dashboard within an hour of arrival (during the 08:00–20:00 polling window).
- **Every** relevant email — including replies inside tracked conversations — produces a structured row (company/role/step/category/date-time/summary) in the Sheet; nothing is silently skipped.
- A position with a scheduled upcoming interview never shows "Applied"; "Offer" appears only for genuine job offers.
- User can change status in the dashboard and it persists in the Sheet without being overwritten by ingestion or reprocess.
- No duplicate rows for the same email.
- Misclassified emails are repairable offline: reprocess shows a diff before applying corrections.
- All required UI states are present and usable on mobile width.

## 15. Next stage
Stage 4 — Stack selection (`/stack-picker`) to confirm Next.js + Claude + googleapis + scheduler choices, then Stage 5 architecture-lite. (Stage 2/3 — stories + UX — can run in parallel given the small scope.)

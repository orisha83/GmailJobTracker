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
| AI provider | Gemini 2.5 Flash (free tier), behind a swappable interface |
| Users | Single user only |
| Notifications | Email-to-self (v1) |
| Polling frequency | Hourly (assumption) |

## 7. MVP scope (thin vertical slices, in build order)
1. **Auth** — Google OAuth login; user grants Gmail read + Sheets read/write scopes. Refresh token stored securely (secret/env), not in the Sheet.
2. **Ingestion + analysis** — Scheduled backend job searches Gmail with the bilingual query, sends new messages to the AI provider (Gemini 2.5 Flash, behind a swappable interface), gets structured JSON, appends relevant rows to the Sheet. Dedup by Gmail message ID, tracked out of the visible data area.
3. **Dashboard read** — Web table listing tracked opportunities: company / role / type / interview date-time / summary / status / received date.
4. **Status editing** — User changes pipeline status from the dashboard; write back to the Sheet without the ingestion job overwriting manual edits.
5. **Scheduling** — Hourly poll so ingestion runs without the user being present.
6. **Notification** — Email-to-self when a new relevant opportunity is detected (carried over from prototype).

## 8. Data model (Google Sheet columns)
| Column | Field | Source | Notes |
|---|---|---|---|
| A | Received date | Gmail | Email date |
| B | Company | Claude | Translated to English |
| C | Role | Claude | Translated to English |
| D | Type | Claude | Interview / Phone Call / Home Assignment / HR Meeting |
| E | Interview date/time | Claude | Resolved using email date for relative phrases ("next Tuesday"); blank if none |
| F | Summary | Claude | 1-sentence English summary |
| G | Status | User/system | Default: `Review Needed`. Pipeline values below. User-editable, never overwritten by ingestion. |
| H | Message ID | Gmail | Dedup key |

**Pipeline status values:** `Review Needed` → `Replied` → `Scheduled` → `Done` (plus `Rejected` / `Archived`).

Processed message IDs (incl. non-relevant) are tracked separately (hidden sheet / dedicated range) so the visible data stays clean — no "Not Relevant" junk rows.

## 9. AI extraction contract
The AI provider (Gemini 2.5 Flash for v1, behind a `EmailAnalyzer` interface so Claude/other can be swapped in) receives the email subject, body (truncated), and email date. Returns JSON:
```json
{
  "is_relevant": true,
  "company": "string (English)",
  "role": "string (English)",
  "type": "Interview | Phone Call | Home Assignment | HR Meeting",
  "interview_datetime": "ISO 8601 or null",
  "summary": "1-sentence English summary"
}
```

## 10. User journeys
1. **First-time setup** — User opens app → signs in with Google → grants Gmail + Sheets access → points app at a Sheet → sees empty dashboard.
2. **Automatic capture** — Hourly, the backend finds a new recruiter email → Claude extracts details → row appears in dashboard as `Review Needed` → user gets an email notification.
3. **Triage** — User opens dashboard → sees new opportunity with date/time → updates status to `Scheduled`.
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
- Hourly polling is sufficient.
- One pre-existing Google Sheet, provided by the user.
- Email-to-self notification is enough for v1.
- Same bilingual Gmail search query as the prototype is a good starting filter.

## 13. Open questions
- [ ] Should `interview_datetime` parsing handle time zones explicitly (assume Asia/Jerusalem)?
- [ ] Google Cloud project setup for OAuth consent + Gemini API key (free tier).

## 14. Success criteria (MVP done when)
- User can connect Google and see recruiter emails auto-appear in the dashboard within an hour of arrival.
- Each relevant email produces a structured row (company/role/type/date-time/summary) in the Sheet.
- User can change status in the dashboard and it persists in the Sheet without being overwritten.
- No duplicate rows for the same email.
- All required UI states are present and usable on mobile width.

## 15. Next stage
Stage 4 — Stack selection (`/stack-picker`) to confirm Next.js + Claude + googleapis + scheduler choices, then Stage 5 architecture-lite. (Stage 2/3 — stories + UX — can run in parallel given the small scope.)

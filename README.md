# Gmail Job Tracker

A personal, self-hosted job-application tracker. Every hour it scans **your** Gmail for
application / interview / recruiter emails — including replies inside conversations it
already tracks — an AI model classifies each one, and the results land in **your** Google
Sheet and on a clean dashboard — with an optional email digest when something new arrives.

No server to run, no database to manage. It's a Next.js app on Vercel, a Google Sheet as
the store, and one external cron pinging a protected endpoint. Runs at ~$0 on free tiers.

```
External cron ──Bearer CRON_SECRET──▶ /api/cron/poll ──▶ Gmail (read)
                                            │
                                            ├──▶ AI provider (classify)
                                            ├──▶ Google Sheet (store)
                                            └──▶ Gmail (send you a digest)
   Browser ──▶ /  (dashboard reads the Sheet)
```

## Features

- **Hands-off ingestion** — scans Gmail on a schedule, per **message** (a reply carrying
  an interview invite is never missed), with incremental watermarks and per-run cost caps.
- **AI classification** — defaults to free **Google Gemini** (rules classify templated
  mail for $0 first); switch to Anthropic **Claude** with one env var.
- **Stage-aware status** — each position's status is derived from all of its emails: an
  "under review" ack can't hide a scheduled interview, and "Offer" means a real job offer.
- **Repairable** — raw emails are cached in a hidden tab; `scripts/reprocess.mjs` re-runs
  the classifier offline and shows a diff before writing anything (manual edits are safe).
- **Your data, your account** — everything lives in your own Gmail + Google Sheet.
- **Dashboard** — opportunities grouped by company/position, with search, sort, calendar
  links, and mobile-friendly layout.
- **Digest emails** — bundled notifications, rate-limited so you get at most one per window.
- **Bilingual** — default search query covers English + Hebrew application lifecycle terms
  (fully overridable).

## Get started

👉 **[SETUP.md](SETUP.md)** — a complete, step-by-step setup guide.

It's written to be run **with [Claude Code](https://claude.com/claude-code)**: clone the
repo, open it in Claude Code, and say *"Help me set this up using SETUP.md."* Claude walks
you through Google Cloud, OAuth, the Sheet, your AI key, deploy, and cron — editing files
and verifying as it goes. You can also follow it by hand.

## Tech

Next.js (App Router) · Google Sheets API · Gmail API · Anthropic / Gemini · Vercel.
The app lives in [`/web`](web/). Architecture and design notes are in [`docs/`](docs/).

## License

[MIT](LICENSE) © Ori Shalom

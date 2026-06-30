# Gmail Job Tracker

A personal, self-hosted job-application tracker. Every couple of hours it scans **your**
Gmail for application / interview / recruiter emails, an AI model classifies each one, and
the results land in **your** Google Sheet and on a clean dashboard — with an optional email
digest when something new arrives.

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

- **Hands-off ingestion** — scans Gmail on a schedule with incremental watermarks (no
  re-processing) and per-run cost caps.
- **AI classification** — defaults to Anthropic **Claude Haiku**; switch to free **Google
  Gemini** with one env var.
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

# Setup Checklist — Google Cloud + Gemini (one-time)

These are the manual steps only you can do (they need your Google login). ~10–15 min.
After this, the app can authenticate, read Gmail, write the Sheet, and call Gemini.

> All values you collect go into `web/.env.local` (copy from `web/.env.example`).
> `.env.local` is gitignored — never commit it.

---

## 1. Create / pick a Google Cloud project
1. Go to https://console.cloud.google.com/
2. Create a project (e.g. "Job Inbox Tracker") or pick an existing one.

## 2. Enable the APIs
In the project, enable both:
- **Gmail API** — https://console.cloud.google.com/apis/library/gmail.googleapis.com
- **Google Sheets API** — https://console.cloud.google.com/apis/library/sheets.googleapis.com

## 3. Configure the OAuth consent screen
1. APIs & Services → **OAuth consent screen**.
2. User type: **External**. Fill app name, your email for support/developer contact.
3. **Scopes**: you can leave the scope list empty here (the app requests scopes at
   runtime). If asked, the app uses: `gmail.readonly`, `gmail.send`, `spreadsheets`.
4. **Test users**: add **your own Gmail address**. (The app stays *unverified* — you'll
   see a "Google hasn't verified this app" screen; click **Advanced → Go to … (unsafe)**.
   This is expected and fine for personal/test use.)
5. Publishing status: leave as **Testing**.

## 4. Create the OAuth client credentials
1. APIs & Services → **Credentials** → **Create credentials** → **OAuth client ID**.
2. Application type: **Web application**.
3. **Authorized redirect URIs** → add:
   - `http://localhost:3000/api/auth/callback` (local dev)
   - (later, for Vercel) `https://YOUR-APP.vercel.app/api/auth/callback`
4. Create → copy the **Client ID** and **Client secret**.
   - → `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

## 5. Create the tracker Google Sheet
1. Create a new Google Sheet (any name) in the **same Google account**.
2. Copy its ID from the URL: `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
   - → `SHEET_ID`
3. You don't need to add tabs/headers — the app creates the `Tracker` and `Processed`
   tabs and the header row automatically on first run.

## 6. Get a Gemini API key (free tier)
1. Go to https://aistudio.google.com/app/apikey
2. Create an API key (free tier is fine for hourly single-user use).
   - → `GEMINI_API_KEY`

## 7. Fill in `web/.env.local`
```bash
cd web
cp .env.example .env.local
# edit .env.local and set:
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SHEET_ID, GEMINI_API_KEY, NOTIFY_EMAIL (your email)
#   CRON_SECRET  -> any long random string, e.g.  openssl rand -hex 32
```

## 8. Get your refresh token (via the app)
1. Start the app: `cd web && npm run dev`
2. Visit **http://localhost:3000/api/auth/google**
3. Sign in, click through the "unverified app" screen, grant access.
4. The callback page shows your **refresh token** — copy it into `.env.local` as
   `GOOGLE_REFRESH_TOKEN`, then restart `npm run dev`.

## 9. Verify
- Visit **http://localhost:3000/api/health** → should show `"configReady": true`
  with an empty `missingConfig`.

When that's green, tell me — I'll wire up and test the ingestion (`/api/cron/poll`),
then build the dashboard.

---

### What's deferred to deployment
- Add the Vercel redirect URI (step 4) and set all the same env vars in the Vercel
  project before the first cloud deploy.
- The hourly schedule (Vercel Cron) is configured at deploy time.

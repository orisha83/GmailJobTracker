// One-off: clear Tracker/Processed/Meta so the next poll re-ingests from today.
// Run with: node --env-file=.env.local scripts/reset.mjs   (delete after use)
import { google } from "googleapis";

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, SHEET_ID } = process.env;
const oauth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
oauth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
const sheets = google.sheets({ version: "v4", auth: oauth });

for (const range of ["Tracker!A:Z", "Processed!A:Z", "Meta!A:Z", "Raw!A:Z"]) {
  try {
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range });
    console.log("cleared", range);
  } catch (e) {
    console.log("skip", range, "-", e.message);
  }
}
console.log("done");

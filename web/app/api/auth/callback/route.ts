import { NextRequest, NextResponse } from "next/server";
import { makeOAuthClient } from "@/lib/google/auth";

/**
 * OAuth redirect target. Exchanges the code for tokens and displays the refresh
 * token so it can be pasted into GOOGLE_REFRESH_TOKEN (env). Single-user MVP:
 * we intentionally don't persist it server-side — the env secret is the store.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    return htmlResponse(`<h1>Authorization failed</h1><p>${escapeHtml(error)}</p>`, 400);
  }
  if (!code) {
    return htmlResponse("<h1>Missing authorization code</h1>", 400);
  }

  try {
    const client = makeOAuthClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.refresh_token) {
      return htmlResponse(
        `<h1>No refresh token returned</h1>
         <p>Google only returns a refresh token on first consent. Remove this app's
         access at <a href="https://myaccount.google.com/permissions">Google account
         permissions</a>, then visit <code>/api/auth/google</code> again.</p>`,
        400,
      );
    }

    return htmlResponse(
      `<h1>✅ Connected</h1>
       <p>Copy this refresh token into your environment as
       <code>GOOGLE_REFRESH_TOKEN</code> (in <code>.env.local</code> locally, or
       Vercel project env vars), then restart the app:</p>
       <pre style="white-space:pre-wrap;word-break:break-all;background:#f4f4f4;padding:12px;border-radius:8px">${escapeHtml(
         tokens.refresh_token,
       )}</pre>
       <p>After setting it, check <a href="/api/health">/api/health</a> — it should
       show <code>configReady: true</code> once all secrets are present.</p>`,
    );
  } catch (err) {
    return htmlResponse(
      `<h1>Token exchange failed</h1><p>${escapeHtml(
        err instanceof Error ? err.message : String(err),
      )}</p>`,
      500,
    );
  }
}

function htmlResponse(body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Job Inbox Tracker — Auth</title>
     <body style="font-family:system-ui;max-width:680px;margin:40px auto;padding:0 16px">${body}</body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

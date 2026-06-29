/**
 * Google OAuth2 client factory. Single-user MVP: the long-lived refresh token
 * lives in an env secret and is used to mint access tokens on demand.
 * See docs/ArchitectureLite.md §6.
 */
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { assertConfig, config } from "@/lib/config";

/** Scopes the app requests during consent. */
export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send", // notification email to self
  "https://www.googleapis.com/auth/spreadsheets",
];

/** Bare client for the consent + callback (token-exchange) flow. */
export function makeOAuthClient(): OAuth2Client {
  assertConfig(["google.clientId", "google.clientSecret"]);
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
}

/** Client pre-loaded with the stored refresh token, for background jobs. */
export function makeAuthedClient(): OAuth2Client {
  assertConfig(["google.clientId", "google.clientSecret", "google.refreshToken"]);
  const client = makeOAuthClient();
  client.setCredentials({ refresh_token: config.google.refreshToken });
  return client;
}

/** Consent URL — `offline` + `prompt=consent` guarantees a refresh token. */
export function getConsentUrl(state?: string): string {
  return makeOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: OAUTH_SCOPES,
    state,
  });
}

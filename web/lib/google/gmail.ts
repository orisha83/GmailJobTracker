/**
 * Gmail access: search for candidate emails and extract subject/body/date.
 * Read-only except for the self-notification (sent elsewhere).
 */
import { google, type gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export interface FetchedMessage {
  id: string;
  subject: string;
  body: string;
  /** ISO 8601 received date. */
  date: string;
  /** Sender display name, e.g. "Check Point HR" (may be empty). */
  senderName: string;
  /** Sender domain, e.g. "checkpoint.com" (lowercased; may be empty). */
  senderDomain: string;
}

/** Parses a From header like `"Acme Careers" <jobs@acme.com>` into name + domain. */
function parseFrom(from: string): { name: string; domain: string } {
  if (!from) return { name: "", domain: "" };
  const emailMatch = from.match(/<([^>]+)>/) ?? from.match(/([^\s<>]+@[^\s<>]+)/);
  const email = emailMatch ? emailMatch[1].trim() : "";
  const domain = email.includes("@") ? email.split("@")[1].toLowerCase().trim() : "";
  // Display name = the part before <...>, stripped of quotes.
  let name = from.replace(/<[^>]*>/, "").trim().replace(/^"|"$/g, "").trim();
  if (!name && email) name = email.split("@")[0];
  return { name, domain };
}

function gmailClient(auth: OAuth2Client): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth });
}

export interface ThreadHit {
  threadId: string;
  /** The most recent message in that thread (what we analyze). */
  latestMessageId: string;
}

/**
 * Returns one hit per matching Gmail THREAD (conversation), newest first.
 * messages.list is reverse-chronological and includes each message's threadId,
 * so the first message seen per thread is its latest — we dedup on that without
 * extra API calls. This collapses reply chains / calendar invites / reminders
 * into a single tracked opportunity per conversation.
 */
export async function searchThreads(
  auth: OAuth2Client,
  query: string,
  maxResults = 100,
): Promise<ThreadHit[]> {
  const gmail = gmailClient(auth);
  const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
  const seen = new Set<string>();
  const hits: ThreadHit[] = [];
  for (const m of res.data.messages ?? []) {
    if (!m.id || !m.threadId || seen.has(m.threadId)) continue;
    seen.add(m.threadId);
    hits.push({ threadId: m.threadId, latestMessageId: m.id });
  }
  return hits;
}

/** Recursively walk MIME parts and decode the first text/plain body found. */
function extractPlainBody(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return "";

  const decode = (data?: string | null): string =>
    data ? Buffer.from(data, "base64url").toString("utf-8") : "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decode(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    const found = extractPlainBody(part);
    if (found) return found;
  }
  // Fall back to top-level body (e.g. simple messages) even if not text/plain.
  return decode(payload.body?.data);
}

/** Fetches one message and extracts the fields we analyze. */
export async function fetchMessage(
  auth: OAuth2Client,
  id: string,
): Promise<FetchedMessage | null> {
  const gmail = gmailClient(auth);
  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const msg = res.data;
  if (!msg.payload) return null;

  const headers = msg.payload.headers ?? [];
  const subject =
    headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "(no subject)";
  const { name: senderName, domain: senderDomain } = parseFrom(
    headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "",
  );

  // internalDate is epoch ms as a string; fall back to the Date header.
  const date = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : new Date(
        headers.find((h) => h.name?.toLowerCase() === "date")?.value ?? Date.now(),
      ).toISOString();

  return {
    id,
    subject,
    body: extractPlainBody(msg.payload),
    date,
    senderName,
    senderDomain,
  };
}

/** Sends a plain-text email as the authenticated user (self-notification). */
export async function sendEmail(
  auth: OAuth2Client,
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  const gmail = gmailClient(auth);
  // RFC 2822 message, base64url-encoded. Encode subject for non-ASCII (Hebrew).
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
  const raw = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");
  const encoded = Buffer.from(raw, "utf-8").toString("base64url");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw: encoded } });
}

/**
 * Gmail access: search for candidate emails and extract subject/body/date.
 * Read-only except for the self-notification (sent elsewhere).
 */
import { google, type gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export interface FetchedMessage {
  id: string;
  /** Gmail thread (conversation) this message belongs to. */
  threadId: string;
  subject: string;
  body: string;
  /** ISO 8601 received date. */
  date: string;
  /** Sender display name, e.g. "Check Point HR" (may be empty). */
  senderName: string;
  /** Sender domain, e.g. "checkpoint.com" (lowercased; may be empty). */
  senderDomain: string;
  /** Candidate URLs found in the email (anchors + plain-text), filtered of junk.
   *  The AI picks the best job/careers link from these. */
  links: string[];
  /** True if this is one of our own digest emails (carries the X-Job-Tracker
   *  header) — never treat it as job mail, else we'd loop on our own alerts. */
  isSelfNotification: boolean;
}

// Custom header stamped on our digest emails so ingestion can recognize and
// skip them (they land in the same inbox we scan). See sendEmail / fetchMessage.
export const NOTIFICATION_HEADER = "X-Job-Tracker";
export const NOTIFICATION_HEADER_VALUE = "notification";

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

export interface MessageHit {
  messageId: string;
  threadId: string;
}

/**
 * Returns every matching Gmail MESSAGE, newest first. Every message counts —
 * an interview invite often arrives as a reply inside an already-tracked
 * conversation, so collapsing to one hit per thread would silently drop it
 * (the "stuck on Applied" bug). Dedup against already-processed message IDs
 * happens in the poller, not here.
 */
export async function searchMessages(
  auth: OAuth2Client,
  query: string,
  maxResults = 300,
): Promise<MessageHit[]> {
  const gmail = gmailClient(auth);
  const hits: MessageHit[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(100, maxResults - hits.length),
      pageToken,
    });
    for (const m of res.data.messages ?? []) {
      if (m.id && m.threadId) hits.push({ messageId: m.id, threadId: m.threadId });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && hits.length < maxResults);
  return hits;
}

/**
 * All message IDs in one thread (metadata-only — cheap), oldest first.
 * Used by the repair tools to find messages that were never analyzed under
 * the old one-row-per-thread scheme.
 */
export async function listThreadMessageIds(
  auth: OAuth2Client,
  threadId: string,
): Promise<{ messageId: string; internalDate: string }[]> {
  const gmail = gmailClient(auth);
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: ["Date"],
  });
  return (res.data.messages ?? [])
    .filter((m) => m.id)
    .map((m) => ({
      messageId: m.id as string,
      internalDate: m.internalDate
        ? new Date(Number(m.internalDate)).toISOString()
        : "",
    }));
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

// Links we never want to surface as a "company site" — list/footer noise.
const JUNK_LINK_RE =
  /(unsubscribe|mailto:|tel:|\/preferences|\/privacy|\/terms|facebook\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|linkedin\.com\/(?:in|sharing)|t\.me|\.(?:png|jpe?g|gif|svg|css|js)(?:[?#]|$))/i;

/** Walk MIME parts and collect candidate URLs from anchors (HTML) and raw text. */
function collectLinks(payload: gmail_v1.Schema$MessagePart | undefined, out: Set<string>): void {
  if (!payload || out.size >= 15) return;

  const decode = (data?: string | null): string =>
    data ? Buffer.from(data, "base64url").toString("utf-8") : "";

  const add = (url: string) => {
    const u = url.trim().replace(/[)\]"'.,>]+$/, "");
    if (/^https?:\/\//i.test(u) && !JUNK_LINK_RE.test(u) && out.size < 15) out.add(u);
  };

  if (payload.mimeType === "text/html" && payload.body?.data) {
    const html = decode(payload.body.data);
    for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  } else if (payload.mimeType === "text/plain" && payload.body?.data) {
    const text = decode(payload.body.data);
    for (const m of text.matchAll(/https?:\/\/[^\s<>"')]+/gi)) add(m[0]);
  }
  for (const part of payload.parts ?? []) collectLinks(part, out);
}

/** Deduped, junk-filtered candidate links from the whole message (capped). */
function extractLinks(payload?: gmail_v1.Schema$MessagePart): string[] {
  const out = new Set<string>();
  collectLinks(payload, out);
  return [...out];
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

  const isSelfNotification =
    headers.find((h) => h.name?.toLowerCase() === NOTIFICATION_HEADER.toLowerCase())?.value ===
    NOTIFICATION_HEADER_VALUE;

  return {
    id,
    threadId: msg.threadId ?? "",
    subject,
    body: extractPlainBody(msg.payload),
    date,
    senderName,
    senderDomain,
    links: extractLinks(msg.payload),
    isSelfNotification,
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
    // Stamp our own alerts so ingestion can skip them (they hit the same inbox).
    `${NOTIFICATION_HEADER}: ${NOTIFICATION_HEADER_VALUE}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");
  const encoded = Buffer.from(raw, "utf-8").toString("base64url");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw: encoded } });
}

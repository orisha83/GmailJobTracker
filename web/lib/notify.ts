/**
 * "New opportunity" notification, sent to the user's own inbox (carried over
 * from the prototype). Uses Gmail send under the same OAuth client.
 */
import type { OAuth2Client } from "google-auth-library";
import { config } from "@/lib/config";
import { sendEmail } from "@/lib/google/gmail";
import type { Analysis } from "@/lib/ai/analyzer";

export async function notifyNewOpportunity(
  auth: OAuth2Client,
  originalSubject: string,
  analysis: Analysis,
): Promise<void> {
  const to = config.ingest.notifyEmail;
  if (!to) return; // notifications optional

  const subject = `🚨 Job Agent: New update from ${analysis.company}`;
  const when = analysis.interview_datetime
    ? `\nProposed time: ${analysis.interview_datetime}`
    : "";
  const body = `Your job agent detected an important email regarding an interview or next step.

Company: ${analysis.company}
Role: ${analysis.role}
Type: ${analysis.type}${when}
Summary: ${analysis.summary}

Original email subject: "${originalSubject}"

It has been logged in your tracker.`;

  await sendEmail(auth, to, subject, body);
}

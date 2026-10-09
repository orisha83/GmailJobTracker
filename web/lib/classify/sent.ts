/**
 * The candidate's OWN sent mail: did this message submit a home assignment?
 * Rules only (no AI). Submissions are usually a link in the body ("Attached is
 * the link to my deck", "מצ״ב לינק לפתרון המטלה"), not an attachment, so we
 * look for submission language near assignment words — in the message's own
 * text, never in the quoted history below it (that's the company's wording).
 * Scheduling replies and nudges ("I sent my solution on Monday…") don't count.
 */
import type { FetchedMessage } from "@/lib/google/gmail";

export const SUBMITTED_STEP = "Assignment submitted";

// Where the quoted conversation starts in a reply.
const QUOTE_START_RE =
  /(^|\n)\s*(?:On .{0,160}?(?:wrote|כתב(?:ה)?)\s*:|ב?תאריך .{0,200}?(?:מאת|כתב(?:ה)?).{0,160}?:|-{2,}\s*Original Message|From:\s.+\n\s*Sent:|>)/i;

/** The part of a reply the candidate actually wrote, as flowing text: plain
 *  mail is hard-wrapped ("מצ״ב לינק\n<url>\nלפתרון המטלה"), so line breaks
 *  become spaces and URLs become the word "link". */
export function ownText(body: string): string {
  const m = QUOTE_START_RE.exec(body || "");
  return (m ? body.slice(0, m.index) : body || "")
    .replace(/[’‘ʼ`´]/g, "'")
    .replace(/<?https?:\/\/[^\s>]+>?/g, " link ")
    .replace(/\s+/g, " ")
    .trim();
}

const SUBMIT_EN =
  String.raw`(?:attached|attaching|please find|here(?: is|'s| are)|enclosed|(?:pleased|happy|excited|glad) to (?:submit|share|send)|submitting|i(?:'m| am) sending|link to my|sharing my)`;
const ASSIGNMENT_EN =
  String.raw`(?:assignment|home ?task|take[- ]home|exercise|solution|deck|presentation|case study|challenge|deliverables?|mock-?up)`;
const SUBMIT_HE = String.raw`(?:מצ["״']?ב|מצורפ(?:ת|ים|ות)?|מגיש(?:ה)?|אני שולח(?:ת)?|שולח(?:ת)? (?:לך|לכם|את))`;
const ASSIGNMENT_HE = String.raw`(?:מטל|תרגיל|פתרון|מצגת|משימ)`;

// Submission language and an assignment word in the same sentence, either order.
const SUBMISSION_RE = new RegExp(
  [
    String.raw`${SUBMIT_EN}[^.!?]{0,80}\b${ASSIGNMENT_EN}`,
    String.raw`\b${ASSIGNMENT_EN}[^.!?]{0,40}\b(?:is |are )?(?:attached|enclosed)`,
    String.raw`${SUBMIT_HE}[^.!?]{0,60}${ASSIGNMENT_HE}`,
  ].join("|"),
  "i",
);

/** A submitted home assignment → its step + summary; anything else → null. */
export function classifySent(
  msg: Pick<FetchedMessage, "subject" | "body">,
): { step: string; summary: string } | null {
  if (!SUBMISSION_RE.test(ownText(msg.body))) return null;
  return { step: SUBMITTED_STEP, summary: `You submitted: ${msg.subject.replace(/^(?:re|fwd?):\s*/i, "")}` };
}

/**
 * Free, no-AI classification for the formulaic ends of the funnel:
 * acknowledgements ("thanks for applying") and rejections. These are high-volume
 * and templated, so we detect them with rules and reserve the scarce Gemini
 * quota for actual interview invitations.
 *
 * Returns a complete Analysis for a confident ack/rejection, or null to mean
 * "let the AI handle this" (likely an invitation, or ambiguous).
 */
import type { Analysis } from "@/lib/ai/analyzer";
import type { FetchedMessage } from "@/lib/google/gmail";

const ACK_RE =
  /(thank you for applying|thanks for applying|thank you for your (?:interest|application)|we(?:'ve| have| ?)? ?(?:got it|received your (?:application|cv|resume))|application (?:has been )?received|received your application|we are reviewing your application|under review|תודה על (?:הגשת|פנייתך|התעניינות|הגשתך)|קיבלנו את (?:מועמדות|פנייתך|קורות)|מועמדות[ךn]? התקבלה)/i;

const REJECTION_RE =
  /(unfortunately|we (?:regret|are sorry) to inform|regret to inform|not (?:be )?(?:moving|proceeding|progressing|continuing) (?:forward|with)|will not be (?:moving|proceeding|progressing|continuing)|won'?t be (?:moving|proceeding|continuing)|(?:decided|chosen) (?:not to (?:move|proceed|continue|advance|progress)|to (?:move|proceed) with other)|other candidates|move forward with other|position (?:has been|was|is now) filled|no longer (?:available|under consideration)|not (?:to )?(?:be )?selected|wish(?:ing)? you (?:all )?(?:the best|success) in your|לצערנו|לא נמשיך|לא נתקדם|לא נוכל להמשיך|הוחלט (?:שלא|לא)|לא נבחרת|מאחל(?:ים)? לך הצלחה)/i;

// Weak rejection-ish cues ("best of luck", "future opportunities", "not to
// continue"). Alone they prove nothing — ack templates use them too — but an
// acknowledgement carrying one is no longer safe to shortcut: rejections often
// OPEN with "thank you for applying" (the Aidoc miss). Ack + cue → let the AI
// read the whole email.
const REJECTION_CUE_RE =
  /(not to (?:continue|proceed|move|advance|progress)|at this (?:stage|time|point)[,.]|best of luck|wish(?:ing)? you (?:all )?the best|future (?:opportunities|openings|roles)|better fit|keep (?:an eye on|you(?:r CV| in mind))|לא להמשיך|בשלב זה|בהצלחה|הזדמנויות עתידיות)/i;

// Strong, present-tense invitation language → don't shortcut; let the AI decide.
const INVITATION_RE =
  /(please (?:schedule|book|pick|select|choose|confirm)|book a (?:time|slot|call|meeting)|what times work|are you available|your availability|let'?s (?:set up|schedule|find a time)|set up a (?:call|meeting|chat)|schedule (?:a |an |your )?(?:call|interview|meeting|chat|time)|invite you to (?:an? |the )?(?:[\w-]+ )?(?:interview|call|meeting|chat)|invitation to (?:an? )?interview|complete the (?:assignment|task|assessment|exercise)|home assignment|technical (?:assessment|test|exercise)|calendly|cal\.com|נשמח לתאם|מוזמן(?:ת)? ל(?:ראיון|שיחה|פגישה)|זימון לראיון|לקבוע (?:שיחה|ראיון|פגישה))/i;

// Broader interview/recruiter signal — used to decide whether an unclassified
// email is worth an (expensive, capped) AI call vs. skipped as noise.
// Bare "offer" stays on purpose: real offers phrase it freely ("pleased to
// extend an offer") and a false positive here only costs one AI call, while a
// false negative silently loses an offer email. The "offer you an interview"
// misread is handled downstream (prompt + guardOfferDowngrade), not by the gate.
const INTERVIEW_SIGNAL_RE =
  /(interview|phone screen|screening|recruiter|talent acquisition|hiring manager|next step|move forward|schedule|availability|set up a|chat with|speak with|home assignment|assessment|offer|ראיון|זימון|לתאם|שיחה (?:עם|טלפונית)|מעוניינים לראיין|הצעת עבודה|הצעת שכר)/i;

/**
 * Should an email the rules couldn't classify be sent to the AI? Only if it
 * shows interview/recruiter signal — otherwise it's broad-query noise
 * (newsletters etc.) and we skip it for free to protect the daily AI budget.
 */
export function looksLikeInvitation(msg: FetchedMessage): boolean {
  return (
    INVITATION_RE.test(`${msg.subject}\n${msg.body}`) ||
    INTERVIEW_SIGNAL_RE.test(`${msg.subject}\n${msg.body}`)
  );
}

const GENERIC_SENDER_RE =
  /^(no.?reply|do.?not.?reply|careers?|recruit(?:ing|ment)?|jobs?|talent|hiring|notifications?|hr|hello|info|support|team|mailer|mail|admin|apply|application|greenhouse|lever|workday|comeet|workable)\b/i;

function cleanCompany(name: string): string {
  return name
    .replace(/\s*[|\-–—:]\s*(careers?|recruit(?:ing|ment)?|talent|hr|jobs?|hiring|team).*$/i, "")
    .replace(/\s+(careers?|recruit(?:ing|ment)?|talent|hr|jobs?|hiring|team)$/i, "")
    .trim();
}

function titleizeDomain(domain: string): string {
  const label = (domain.split(".")[0] || "").replace(/[-_]/g, " ").trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "Unknown";
}

// A subject capture that is actually a ROLE, not a company ("applying to the
// Platform Product Manager role").
const ROLE_NOT_COMPANY_RE = /^the\b|\b(?:role|position|opening)s?$/i;

function subjectCompany(subject: string): string {
  const s = subject || "";
  const m =
    s.match(/(?:applying|application|applied) (?:to|with|at|for a position at)\s+([A-Za-z0-9][\w .&'\-]{1,40})/i) ||
    s.match(/(?:position|role) (?:at|with)\s+([A-Za-z0-9][\w .&'\-]{1,40})/i) ||
    s.match(/\bat\s+([A-Z][\w .&'\-]{1,40})/);
  if (!m) return "";
  const c = cleanCompany(m[1]).replace(/[^\w)']+$/g, "").trim();
  return ROLE_NOT_COMPANY_RE.test(c) ? "" : c;
}

function extractCompany(msg: FetchedMessage): string {
  // Explicit naming beats the sender's display name: recruiters send from
  // their PERSONAL name ("Channi Refaelovich") while the subject/body says
  // which company the application is with.
  const fromSubject = subjectCompany(msg.subject);
  if (fromSubject) return fromSubject;

  // ATS relay bodies state it outright: "Sent by X Recruit on behalf of Acme".
  const behalf = (msg.body || "").match(/on behalf of\s+([A-Z][\w .&'\-]{1,40})/i);
  if (behalf) {
    // Cut at the sentence boundary (". " keeps "Monday.com"-style names intact).
    const c = cleanCompany(behalf[1].split(/\.\s|[,;\n]/)[0]).replace(/[^\w)']+$/g, "").trim();
    if (c) return c;
  }

  const cleaned = cleanCompany(msg.senderName || "");
  if (cleaned && !GENERIC_SENDER_RE.test(msg.senderName || "")) return cleaned;

  return msg.senderDomain ? titleizeDomain(msg.senderDomain) : cleaned || "Unknown";
}

function extractRole(subject: string): string {
  const s = subject || "";
  const m =
    s.match(/(?:applying for|apply for|for the position of|position of|interview for)\s+(?:the\s+)?(.+)$/i) ||
    s.match(/\b(?:position|role)\s*[:\-]\s*(.+)$/i) ||
    s.match(/\bfor\s+(?:the\s+)?([A-Z][^,.!|]*)$/);
  if (!m) return "Unknown";
  // Cut at trailing connectors/words. The lookbehind also splits the glued case
  // ("Managerat Agora" → "Manager", "Managerposition" → "Manager") where the
  // subject lost a space.
  let role = m[1].split(
    /(?:\s+|(?<=[a-z]))(?:at|@|with|position|role|opening|opportunity|req|requisition)\b/i,
  )[0];
  role = role
    .replace(/[^\w)']+$/g, "") // trailing punctuation/emoji
    .replace(/\s+/g, " ")
    .trim();
  // "Thank You for Applying to Ubeya" → capture "Applying to Ubeya" is not a role.
  if (/^apply/i.test(role)) return "Unknown";
  return role.length >= 2 && role.length <= 60 ? role : "Unknown";
}

/** Confident ack/rejection → Analysis; otherwise null (route to AI). */
export function classifyHeuristically(msg: FetchedMessage): Analysis | null {
  const text = `${msg.subject}\n${msg.body}`;

  const base = {
    is_relevant: true as const,
    company: extractCompany(msg),
    role: extractRole(msg.subject),
    interview_datetime: null,
    apply_url: "",
    interviewer_name: "",
  };

  // Rejections are terminal — classify even if some scheduling words appear.
  if (REJECTION_RE.test(text)) {
    return { ...base, category: "Rejection", step: "Rejected", summary: msg.subject };
  }

  // Acknowledgement, but only shortcut when there's no real invitation ask
  // AND no rejection-ish cue — rejections often open with ack language.
  if (ACK_RE.test(text)) {
    if (INVITATION_RE.test(text) || REJECTION_CUE_RE.test(text)) return null; // mixed → let AI decide
    return { ...base, category: "Applied", step: "Applied", summary: msg.subject };
  }

  return null; // unknown → AI
}

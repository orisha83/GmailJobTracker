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
  /(unfortunately|we (?:regret|are sorry) to inform|regret to inform|not (?:be )?(?:moving|proceeding|progressing) forward|will not be (?:moving|proceeding|progressing)|won'?t be (?:moving|proceeding)|decided (?:not to (?:move|proceed)|to (?:move|proceed) with other)|other candidates|move forward with other|position (?:has been|was|is now) filled|no longer (?:available|under consideration)|not (?:to )?(?:be )?selected|wish you (?:the best|success) in your|לצערנו|לא נמשיך|לא נתקדם|לא נוכל להמשיך|הוחלט (?:שלא|לא)|לא נבחרת|מאחל(?:ים)? לך הצלחה)/i;

// Strong, present-tense invitation language → don't shortcut; let the AI decide.
const INVITATION_RE =
  /(please (?:schedule|book|pick|select|choose|confirm)|book a (?:time|slot|call|meeting)|what times work|are you available|your availability|let'?s (?:set up|schedule|find a time)|set up a (?:call|meeting|chat)|schedule (?:a |an |your )?(?:call|interview|meeting|chat|time)|invite you to (?:an? )?(?:interview|call|meeting|chat)|invitation to (?:an? )?interview|complete the (?:assignment|task|assessment|exercise)|home assignment|technical (?:assessment|test|exercise)|calendly|cal\.com|נשמח לתאם|מוזמן(?:ת)? ל(?:ראיון|שיחה|פגישה)|זימון לראיון|לקבוע (?:שיחה|ראיון|פגישה))/i;

// Broader interview/recruiter signal — used to decide whether an unclassified
// email is worth an (expensive, capped) AI call vs. skipped as noise.
const INTERVIEW_SIGNAL_RE =
  /(interview|phone screen|screening|recruiter|talent acquisition|hiring manager|next step|move forward|schedule|availability|set up a|chat with|speak with|home assignment|assessment|offer|ראיון|זימון|לתאם|שיחה (?:עם|טלפונית)|מעוניינים לראיין|הצעת עבודה)/i;

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

function extractCompany(msg: FetchedMessage): string {
  const cleaned = cleanCompany(msg.senderName || "");
  if (cleaned && !GENERIC_SENDER_RE.test(msg.senderName || "")) return cleaned;

  const s = msg.subject || "";
  const m =
    s.match(/applying (?:to|with)\s+([A-Za-z0-9][\w .&'\-]{1,40})/i) ||
    s.match(/position (?:at|with)\s+([A-Za-z0-9][\w .&'\-]{1,40})/i) ||
    s.match(/\bat\s+([A-Z][\w .&'\-]{1,40})/);
  if (m) return cleanCompany(m[1]).replace(/[.,!]$/, "").trim();

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
    .replace(/[\s.,!:;|()\-–—]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
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

  // Acknowledgement, but only shortcut when there's no real invitation ask.
  if (ACK_RE.test(text)) {
    if (INVITATION_RE.test(text)) return null; // mixed → let AI decide
    return { ...base, category: "Applied", step: "Applied", summary: msg.subject };
  }

  return null; // unknown → AI
}

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
import { domainCompanyName } from "@/lib/company";

const ACK_RE =
  /(thank you for applying|thanks for applying|thank you for your (?:interest|application)|we(?:'ve| have| ?)? ?(?:got it|received your (?:application|cv|resume))|application (?:has been )?received|received your application|we are reviewing your application|under review|תודה על (?:הגשת|פנייתך|התעניינות|הגשתך)|קיבלנו את (?:מועמדות|פנייתך|קורות)|מועמדות[ךn]? התקבלה)/i;

const REJECTION_RE =
  /(unfortunately|we (?:regret|are sorry) to inform|regret to inform|not (?:be )?(?:moving|proceeding|progressing|continuing) (?:forward|with)|will not be (?:moving|proceeding|progressing|continuing)|won'?t be (?:moving|proceeding|continuing)|(?:decided|chosen) (?:not to (?:move|proceed|continue|advance|progress)|to (?:move|proceed) with other)|other candidates|move forward with other|(?:position|role|opening) (?:has been|was|is now|is) (?:filled|closed|cancell?ed)|(?:filled|closed) the (?:position|role)|no longer (?:reviewing|accepting|considering) (?:applications|candidates)|no longer (?:available|under consideration)|(?<!if (?:you are|you're|you were) )not (?:to )?(?:be )?selected|wish(?:ing)? you (?:all )?(?:the best|success) in your|(?:mov(?:e|ing)|go(?:ing)?|proceed(?:ing)?) (?:forward )?with (?:other |another |a different |different )?(?:candidates?|applicants?|profiles?)|(?:pursue|pursuing) (?:other|another|different) (?:candidates?|applicants?|profiles?)|whose (?:experience|background|skills?|profiles?) (?:is|are|more closely|better|aligns?)|(?:closer|stronger|better) (?:fit|match) for (?:the|this|our)|not (?:a|the right) (?:fit|match) for|(?:not|un)able to (?:move forward|proceed|offer you)|לא נמצאה התאמה|לצערנו|לא נמשיך|לא נתקדם|לא נוכל להמשיך|לא נוכל להתקדם|לא נוכל להציע|הוחלט (?:שלא|לא)|החלטנו (?:שלא|לא)|מועמד(?:ים|ות) אחר(?:ים|ות)|התאמה (?:טובה|גבוהה) יותר|לא נבחרת|מאחל(?:ים)? לך הצלחה)/i;

// Weak rejection-ish cues ("best of luck", "future opportunities", "not to
// continue"). Alone they prove nothing — ack templates use them too — but an
// acknowledgement carrying one is no longer safe to shortcut: rejections often
// OPEN with "thank you for applying" (the Aidoc miss). Ack + cue → let the AI
// read the whole email.
const REJECTION_CUE_RE =
  /(not to (?:continue|proceed|move|advance|progress)|at this (?:stage|time|point)[,.]|best of luck|wish(?:ing)? you (?:all )?the best|future (?:opportunities|openings|roles)|better fit|keep (?:an eye on|you(?:r CV| in mind))|after careful (?:review|consideration)|encourage you to (?:apply|check back)|(?:keep|retain) your (?:cv|resume|details|information) on file|לא להמשיך|בשלב זה|בהצלחה (?:בהמשך|בחיפוש)|הזדמנויות עתידיות|נשמור את (?:קורות|פרטי))/i;

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

// Mail ABOUT one of the candidate's applications that the rules couldn't
// settle (an unusual rejection, a status update) — worth an AI call, never noise.
// "מועמדותך לתפקיד Product Manager" was dropped here before this existed.
const APPLICATION_STATUS_RE =
  /(your (?:application|candidacy|candidature)|application (?:update|status)|update (?:on|regarding) your|thank you for (?:your )?(?:interest|considering)|מועמדות(?:ך|כם)|הגשת מועמדות|קורות החיים שלך|עדכון (?:לגבי|בנוגע ל|בעניין )?(?:ה)?מועמדות|קורות החיים ששלחת)/i;

/**
 * Should an email the rules couldn't classify be sent to the AI? Only if it
 * shows interview/recruiter signal — otherwise it's broad-query noise
 * (newsletters etc.) and we skip it for free to protect the daily AI budget.
 */
/** Subject + body with typographic apostrophes straightened: templates write
 *  "won’t" / "we’ve", and every rule spells them with a plain "'". Without this
 *  Playtika's and Cloudinary's rejections slipped through as noise. */
const textOf = (msg: FetchedMessage) => `${msg.subject}\n${msg.body}`.replace(/[’‘ʼ`´]/g, "'");

export function looksLikeInvitation(msg: FetchedMessage): boolean {
  const text = textOf(msg);
  return (
    INVITATION_RE.test(text) ||
    INTERVIEW_SIGNAL_RE.test(text) ||
    APPLICATION_STATUS_RE.test(text)
  );
}

/**
 * Stricter gate for walking HISTORY (rescan): only mail that is plainly about
 * the candidate's own application or a concrete invitation earns an AI call.
 * The live gate also admits weak words ("offer", "schedule") — fine for an
 * hourly trickle, but over months of history it sends every store promo and
 * newsletter to a model with a ~20/day free quota.
 */
export function looksLikeApplicationMail(msg: FetchedMessage): boolean {
  const text = textOf(msg);
  return INVITATION_RE.test(text) || APPLICATION_STATUS_RE.test(text) || ACK_RE.test(text);
}

// Requests for the candidate's feedback on the hiring process ("Let us know how
// we did", "Candidate Experience Survey"). Deliberately NOT "feedback from your
// interview" — that's the company's verdict, which can be an invitation.
const FEEDBACK_SURVEY_RE =
  /(candidate (?:experience )?survey|experience survey|(?:take|complete|fill (?:out|in)) (?:a |our |this |the )?(?:short |quick |brief )?survey|let us know how we did|how did we do|rate (?:your|the) (?:interview|recruitment|hiring|candidate|application)|(?:feedback|thoughts|opinion) (?:on|about|regarding) (?:your|the|our) (?:recent )?(?:interview(?:ing)?|recruitment|recruiting|hiring|application|candidate) (?:experience|process)|(?:share|give|provide) (?:us )?(?:your )?(?:feedback|thoughts) (?:on|about) (?:your|the|our) (?:recent )?(?:interview(?:ing)?|recruitment|recruiting|hiring|candidate) (?:experience|process)|סקר (?:חווית|שביעות|מועמד)|משוב על (?:תהליך|חווית)|נשמח לשמוע (?:את )?דעתך על (?:תהליך|חווית))/i;

/** Is this the company surveying the candidate about its hiring process? */
export function isFeedbackSurvey(msg: FetchedMessage): boolean {
  return FEEDBACK_SURVEY_RE.test(textOf(msg));
}

const GENERIC_SENDER_RE =
  /^(no.?reply|do.?not.?reply|careers?|recruit(?:ing|ment)?|jobs?|talent|hiring|notifications?|hr|hello|info|support|team|mailer|mail|admin|apply|application|greenhouse|lever|workday|comeet|workable)\b/i;

function cleanCompany(name: string): string {
  return name
    .replace(/^(?:צוות|קבוצת|מחלקת)\s+(?:ה)?גיוס\s+(?:של\s+)?/, "") // "קבוצת גיוס הפניקס"
    .replace(/\s*[|\-–—:]\s*(careers?|recruit(?:ing|ment)?|talent|hr|jobs?|hiring|team).*$/i, "")
    .replace(/(?:\s+(?:careers?|recruit(?:ing|ment)?|talent(?: acquisition)?|hr|jobs?|hiring|team))+$/i, "")
    .trim();
}

// A role, not a company ("applying to the Platform Product Manager role",
// "Product Manager - Check Point").
const ROLE_LIKE_RE =
  /^the\b|\b(?:role|position|opening|manager|engineer|developer|designer|analyst|lead|director|head of|specialist|owner|architect|scientist|intern)s?\b/i;
// Lower-case words allowed inside a company name ("Bank of Israel").
const NAME_CONNECTORS = new Set(["of", "and", "&", "de", "la", "the"]);
// Capitalized subject words that are never the company.
const NOT_A_COMPANY = new Set([
  "your", "our", "the", "this", "my", "us", "you", "a", "an", "job", "re", "fwd", "update",
  "thank", "thanks", "application", "hi", "hello",
]);

/** Trim a regex capture down to the company: cut at punctuation/separators, at
 *  the first lower-case word ("SciPlay is in!"), and skip role-like segments. */
function companyFromCapture(capture: string): string {
  for (const segment of capture.split(/\s+[-–—|]\s+|\s*[!?,;:()"]|\.\s/)) {
    const words: string[] = [];
    for (const w of segment.trim().split(/\s+/)) {
      if (!w) continue;
      if (/^[a-z]/.test(w) && !NAME_CONNECTORS.has(w) && words.length) break;
      words.push(w);
    }
    while (words.length && NAME_CONNECTORS.has(words[words.length - 1].toLowerCase())) words.pop();
    const c = cleanCompany(words.join(" ")).replace(/[^\p{L}\p{N})']+$/gu, "").trim();
    if (c.length >= 2 && !ROLE_LIKE_RE.test(c) && !NOT_A_COMPANY.has(c.toLowerCase())) return c;
  }
  return "";
}

const NAME = String.raw`([A-Za-z0-9][\w .&'\-–|]{1,60})`;
const SUBJECT_COMPANY_RES = [
  // "…Manager - AI Billing position at monday.com", "Product Manager with
  // SciPlay" — the company right after a role word wins; anchoring on the role
  // also keeps "Interview with Jane Doe" from reading as a company.
  new RegExp(
    String.raw`\b(?:position|role|opening|manager|engineer|developer|designer|analyst|lead|director|specialist|owner|architect|scientist|intern)s? (?:at|with)\s+${NAME}`,
    "i",
  ),
  new RegExp(String.raw`(?:applying|application|applied) (?:to|with|at|in|for a position at)\s+${NAME}`, "i"),
  new RegExp(String.raw`interest in (?:joining )?(?:the team at )?${NAME}`, "i"),
  new RegExp(String.raw`(?:considering|joining)\s+${NAME}`, "i"),
  new RegExp(String.raw`\b[Ff]rom\s+([A-Z][\w .&'\-–|]{1,60})`),
  new RegExp(String.raw`@\s*([A-Z][\w .&'\-–|]{1,60})`),
  new RegExp(String.raw`\bat\s+([A-Z][\w .&'\-–|]{1,60})`),
  // "Similarweb (Job Application Update)", "Act Security Application Update"
  new RegExp(String.raw`^([A-Z][\w.&'\-]*(?: [A-Z][\w.&'\-]*){0,3})\s*(?:\(\s*)?(?:[Jj]ob )?[Aa]pplication\b`),
  // Hebrew: "מועמדותך בקבוצת הראל", "תודה על הגשת מועמדותך - אלביט מערכות"
  /(?:בקבוצת|לקבוצת|בחברת|לחברת)\s+([\u0590-\u05FF][\u0590-\u05FF"'.\s]{1,30})/,
  /מועמד\S*.*?\s[-–]\s*([\u0590-\u05FF][\u0590-\u05FF"'.\s]{1,30})$/,
];

function subjectCompany(subject: string): string {
  const s = (subject || "").replace(/^(?:re|fwd?):\s*/i, "");
  for (const re of SUBJECT_COMPANY_RES) {
    const m = s.match(re);
    const c = m ? companyFromCapture(m[1]) : "";
    if (c) return c;
  }
  return "";
}

// Words that make a two-word display name a company, not a person
// ("Discount Bank" @dbank.co.il must not become "Dbank").
const COMPANY_WORD_RE =
  /\b(?:bank|group|labs?|systems|networks|security|technologies|tech|software|capital|health|games|gaming|digital|data|cloud|solutions|media|robotics|ventures|partners|global|international|insurance|energy|motors|payments?|studios?|analytics|ai|io|inc|ltd)\b/i;

// "Jane Doe", "Tal Icigson" — a recruiter's personal display name.
const PERSON_NAME_RE = /^[A-Z][a-z'’]+(?:[- ][A-Z][a-z'’]+){1,3}$/;

/** Does the sender display name plausibly belong to the domain's company? */
function nameMatchesDomain(name: string, domainCompany: string): boolean {
  const a = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = domainCompany.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!a || !b) return false;
  const stem = b.slice(0, Math.min(4, b.length));
  return a.includes(stem) || b.includes(a.slice(0, Math.min(4, a.length)));
}

export function extractCompany(msg: FetchedMessage): string {
  // Explicit naming beats the sender's display name: recruiters send from
  // their PERSONAL name ("Channi Refaelovich") while the subject/body says
  // which company the application is with.
  const fromSubject = subjectCompany(msg.subject);
  if (fromSubject) return fromSubject;

  // ATS relay bodies state it outright: "Sent by X Recruit on behalf of Acme".
  const behalf = (msg.body || "").match(/on behalf of\s+([A-Z][\w .&'\-]{1,40})/i);
  if (behalf) {
    // Cut at the sentence boundary (". " keeps "Monday.com"-style names intact).
    const c = cleanCompany(behalf[1].split(/\.\s|[,;\n]/)[0]).replace(/[^\p{L}\p{N})']+$/gu, "").trim();
    if (c) return c;
  }

  const sender = (msg.senderName || "").trim();
  const fromDomain = domainCompanyName(msg.senderDomain);
  // "Jessica Lamdan - Intelligo" → Intelligo.
  const parts = sender.split(/\s+[-–—|]\s+/);
  const named =
    parts.length > 1 && PERSON_NAME_RE.test(parts[0]) ? parts.slice(1).join(" ") : sender;
  const cleaned = cleanCompany(named);
  const usable = cleaned && !named.includes("@") && !GENERIC_SENDER_RE.test(named);
  // A personal name on a corporate domain ("Tamar Dekel Romano" @gong.io) —
  // the domain names the employer; the person is just the recruiter.
  const isPerson =
    PERSON_NAME_RE.test(cleaned) &&
    !COMPANY_WORD_RE.test(cleaned) &&
    !nameMatchesDomain(cleaned, fromDomain);
  if (usable && !(isPerson && fromDomain)) return cleaned;

  return fromDomain || (usable ? cleaned : "") || "Unknown";
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
    .replace(/[^\p{L}\p{N})']+$/gu, "") // trailing punctuation/emoji
    .replace(/\s+/g, " ")
    .trim();
  // "Thank You for Applying to Ubeya" → capture "Applying to Ubeya" is not a role.
  if (/^apply/i.test(role)) return "Unknown";
  return role.length >= 2 && role.length <= 60 ? role : "Unknown";
}

/** Confident ack/rejection → Analysis; otherwise null (route to AI). */
export function classifyHeuristically(msg: FetchedMessage): Analysis | null {
  const text = textOf(msg);

  const base = {
    is_relevant: true as const,
    company: extractCompany(msg),
    role: extractRole(msg.subject),
    interview_datetime: null,
    apply_url: "",
    interviewer_name: "",
  };

  // Rejections are terminal — classify even if some scheduling words appear.
  // (Checked BEFORE the survey rule: a rejection with a survey link is still news.)
  if (REJECTION_RE.test(text)) {
    return { ...base, category: "Rejection", step: "Rejected", summary: msg.subject };
  }

  // The company asking the CANDIDATE to rate its hiring process carries no
  // pipeline news — the user doesn't want it tracked at all.
  if (isFeedbackSurvey(msg)) {
    return { ...base, is_relevant: false, category: "Other", step: "Feedback survey", summary: msg.subject };
  }

  // Acknowledgement, but only shortcut when there's no real invitation ask
  // AND no rejection-ish cue — rejections often open with ack language.
  if (ACK_RE.test(text)) {
    if (INVITATION_RE.test(text) || REJECTION_CUE_RE.test(text)) return null; // mixed → let AI decide
    return { ...base, category: "Applied", step: "Applied", summary: msg.subject };
  }

  return null; // unknown → AI
}

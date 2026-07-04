/**
 * Provider-agnostic email analysis. Swap the implementation (Gemini today,
 * Claude later) without touching ingestion — see docs/ArchitectureLite.md §4.
 */

/**
 * What the email is in the application lifecycle. Drives color/filter and
 * whether an alert fires: only "Invitation" alerts.
 */
export type OpportunityCategory =
  | "Invitation" // an interview/call/assignment/HR round the candidate must act on
  | "Applied" // acknowledgement: application received / under review
  | "Rejection" // not moving forward
  | "Offer" // an offer was extended
  | "Other"; // job-related but none of the above

export interface EmailInput {
  subject: string;
  /** Plain-text body, already truncated by the caller. */
  body: string;
  /** ISO 8601 timestamp the email was received — used to resolve relative dates. */
  emailDate: string;
  /** Sender display name (hint for the hiring company). */
  senderName?: string;
  /** Sender domain (hint for the hiring company). */
  senderDomain?: string;
  /** Candidate URLs from the email — the model picks the best job/careers link. */
  links?: string[];
}

export interface Analysis {
  is_relevant: boolean;
  /** Company name, translated to English. */
  company: string;
  /** Role / job title, translated to English. */
  role: string;
  category: OpportunityCategory;
  /** Short human label of this email's step, e.g. "HR screen", "VP interview",
   *  "Home assignment", "Applied", "Rejected". Becomes the position's status. */
  step: string;
  /** Proposed interview date/time as ISO 8601, or null if none stated. */
  interview_datetime: string | null;
  /** One-sentence English summary of what's requested from the candidate. */
  summary: string;
  /** Best job-posting / careers / company URL from the email, or "" if none. */
  apply_url: string;
  /** Full name of the person the candidate will interview with, or "" if not stated. */
  interviewer_name: string;
}

export interface EmailAnalyzer {
  /** Returns structured analysis, or null if the provider failed/returned junk. */
  analyze(input: EmailInput): Promise<Analysis | null>;
}

const VALID_CATEGORIES: ReadonlySet<string> = new Set<OpportunityCategory>([
  "Invitation",
  "Applied",
  "Rejection",
  "Offer",
  "Other",
]);

/** Sensible default status label when the model omits a step. */
function defaultStep(category: OpportunityCategory): string {
  switch (category) {
    case "Invitation":
      return "Interview";
    case "Applied":
      return "Applied";
    case "Rejection":
      return "Rejected";
    case "Offer":
      return "Offer";
    default:
      return "Update";
  }
}

/**
 * Coerces an untyped provider response into a safe Analysis, or null if it
 * doesn't even have the relevance flag. Keeps bad model output from crashing
 * ingestion.
 */
// Language that only a real job offer contains. "Package"/"terms" alone are too
// generic; anchor on compensation, contract, and offer-letter vocabulary (EN+HE).
const COMPENSATION_RE =
  /(compensation|salary|equity|stock options?|offer letter|offer of employment|employment (?:agreement|contract)|base pay|annual base|sign(?:ing|-on) bonus|start date|שכר|תנאי העסקה|חוזה העסקה|הצעת שכר|בונוס חתימה|תאריך תחילה)/i;

/**
 * Safety net for the "offer you an interview slot" misread: small models
 * sometimes classify interview-scheduling mail as a job Offer because of the
 * word "offer". A real offer talks terms — an "Offer" that schedules an
 * interview time and never mentions compensation/contract is an Invitation.
 */
export function guardOfferDowngrade(analysis: Analysis, emailText: string): Analysis {
  if (
    analysis.category !== "Offer" ||
    !analysis.interview_datetime ||
    COMPENSATION_RE.test(emailText)
  ) {
    return analysis;
  }
  return {
    ...analysis,
    category: "Invitation",
    step: /offer/i.test(analysis.step) ? "Interview" : analysis.step,
  };
}

/**
 * The candidate can never be their own interviewer. Scheduling emails and
 * calendar invites are full of the candidate's name ("Phone interview — Ori
 * Shalom"), and small models sometimes report it back as interviewer_name.
 */
export function stripSelfInterviewer(analysis: Analysis, candidateName: string): Analysis {
  const self = candidateName.trim().toLowerCase();
  if (!self || analysis.interviewer_name.trim().toLowerCase() !== self) return analysis;
  return { ...analysis, interviewer_name: "" };
}

export function normalizeAnalysis(raw: unknown): Analysis | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.is_relevant !== "boolean") return null;

  // Default to "Other" on missing/invalid so a bad model response never alerts.
  const category =
    typeof r.category === "string" && VALID_CATEGORIES.has(r.category)
      ? (r.category as OpportunityCategory)
      : "Other";

  const step =
    typeof r.step === "string" && r.step.trim() ? r.step.trim() : defaultStep(category);

  return {
    is_relevant: r.is_relevant,
    company: typeof r.company === "string" && r.company.trim() ? r.company.trim() : "Unknown",
    role: typeof r.role === "string" && r.role.trim() ? r.role.trim() : "Unknown",
    category,
    step,
    interview_datetime:
      typeof r.interview_datetime === "string" && r.interview_datetime.trim()
        ? r.interview_datetime.trim()
        : null,
    summary: typeof r.summary === "string" ? r.summary.trim() : "",
    apply_url:
      typeof r.apply_url === "string" && /^https?:\/\//i.test(r.apply_url.trim())
        ? r.apply_url.trim()
        : "",
    interviewer_name:
      typeof r.interviewer_name === "string" ? r.interviewer_name.trim() : "",
  };
}

/**
 * Provider-agnostic email analysis. Swap the implementation (Gemini today,
 * Claude later) without touching ingestion — see docs/ArchitectureLite.md §4.
 */

export type OpportunityType =
  | "Interview"
  | "Phone Call"
  | "Home Assignment"
  | "HR Meeting";

/**
 * What the email actually is, beyond its topic. Drives whether an alert fires:
 * only "Invitation" (a concrete action requested of the candidate now) alerts.
 */
export type OpportunityCategory =
  | "Invitation"
  | "Acknowledgement"
  | "Rejection"
  | "Other";

export interface EmailInput {
  subject: string;
  /** Plain-text body, already truncated by the caller. */
  body: string;
  /** ISO 8601 timestamp the email was received — used to resolve relative dates. */
  emailDate: string;
}

export interface Analysis {
  is_relevant: boolean;
  /** Company name, translated to English. */
  company: string;
  /** Role / job title, translated to English. */
  role: string;
  type: OpportunityType;
  /** Whether this is an actual invitation vs an acknowledgement/rejection/other. */
  category: OpportunityCategory;
  /** Proposed interview date/time as ISO 8601, or null if none stated. */
  interview_datetime: string | null;
  /** One-sentence English summary of what's requested from the candidate. */
  summary: string;
}

export interface EmailAnalyzer {
  /** Returns structured analysis, or null if the provider failed/returned junk. */
  analyze(input: EmailInput): Promise<Analysis | null>;
}

const VALID_TYPES: ReadonlySet<string> = new Set<OpportunityType>([
  "Interview",
  "Phone Call",
  "Home Assignment",
  "HR Meeting",
]);

const VALID_CATEGORIES: ReadonlySet<string> = new Set<OpportunityCategory>([
  "Invitation",
  "Acknowledgement",
  "Rejection",
  "Other",
]);

/**
 * Coerces an untyped provider response into a safe Analysis, or null if it
 * doesn't even have the relevance flag. Keeps bad model output from crashing
 * ingestion.
 */
export function normalizeAnalysis(raw: unknown): Analysis | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.is_relevant !== "boolean") return null;

  const type = typeof r.type === "string" && VALID_TYPES.has(r.type)
    ? (r.type as OpportunityType)
    : "Interview";

  // Default to "Other" on missing/invalid so a bad model response never alerts.
  const category =
    typeof r.category === "string" && VALID_CATEGORIES.has(r.category)
      ? (r.category as OpportunityCategory)
      : "Other";

  return {
    is_relevant: r.is_relevant,
    company: typeof r.company === "string" && r.company.trim() ? r.company.trim() : "Unknown",
    role: typeof r.role === "string" && r.role.trim() ? r.role.trim() : "Unknown",
    type,
    category,
    interview_datetime:
      typeof r.interview_datetime === "string" && r.interview_datetime.trim()
        ? r.interview_datetime.trim()
        : null,
    summary: typeof r.summary === "string" ? r.summary.trim() : "",
  };
}

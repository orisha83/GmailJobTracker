/**
 * Gemini 2.5 Flash implementation of EmailAnalyzer (free tier). Uses a direct
 * REST call so there's no extra SDK dependency — the swappable interface keeps
 * this contained. See docs/StackDecision.md.
 */
import { config } from "@/lib/config";
import {
  type Analysis,
  type EmailAnalyzer,
  type EmailInput,
  normalizeAnalysis,
} from "./analyzer";

const MAX_BODY_CHARS = 3000;

function buildPrompt(input: EmailInput, timezone: string): string {
  const body = input.body.slice(0, MAX_BODY_CHARS);
  return `You are an AI assistant helping a candidate track where each job application stands.
Analyze one email (it may be in Hebrew or English) and report the candidate's CURRENT step for that position.

Set "is_relevant" to true for ANY job-application-related email, false for unrelated mail (newsletters, marketing, personal).

Classify "category":
- "Invitation": the email asks the candidate to act NOW — schedule/attend an interview, phone screen, HR conversation, or complete/submit a home assignment. A concrete next step is requested.
- "Applied": acknowledgement only — application received / under review, or "we'll contact you IF there's a match". No action requested now (conditional/future language counts here).
- "Rejection": not moving forward.
- "Offer": an offer is being extended.
- "Other": job-related but none of the above.

"step": a SHORT label (2-4 words) describing this specific step, used as the position's status. Identify the interview round / who it's with when stated, e.g. "HR screen", "Phone screen", "Recruiter call", "Hiring manager interview", "PM interview", "VP interview", "CEO interview", "Technical interview", "Home assignment", "Final round". For Applied use "Applied"; Rejection "Rejected"; Offer "Offer".

Crucial — conditional/future contact is NOT an invitation:
- "We received your CV; if there's a match we'll contact you for a call." => category "Applied".
- "We'd like to schedule a 30-min call this week — what times work?" => "Invitation", step e.g. "Recruiter call".
- "Please complete the attached assignment by Sunday." => "Invitation", step "Home assignment".

The email was received at: ${input.emailDate} (timezone ${timezone}).
If the email proposes a specific date/time (incl. relative phrases like "next Tuesday at 3pm"), resolve it to an absolute ISO 8601 timestamp using the received date. Otherwise null.

"apply_url": from the Candidate links below, choose the SINGLE URL that best points to this specific job posting / application portal / company careers page or site. Ignore unsubscribe, social, login, and tracking links. Use "" if none fits or the list is empty. Output the URL exactly as listed — never invent one.

"interviewer_name": the full name of the person the candidate will interview with / meet, if explicitly stated (e.g. "You'll meet with Jane Doe"). This is the INTERVIEWER, not the recruiter, coordinator, or sender. Use "" if no interviewer is clearly named.

Email Subject: ${input.subject}
Email Body: ${body}
Candidate links:${input.links?.length ? "\n" + input.links.map((l) => `- ${l}`).join("\n") : " (none)"}

Respond ONLY with a valid JSON object (no markdown fences) using exactly this structure:
{
  "is_relevant": true/false,
  "company": "Company name (translate to English if Hebrew)",
  "role": "Job title or role (translate to English if Hebrew)",
  "category": "Invitation" | "Applied" | "Rejection" | "Offer" | "Other",
  "step": "short step label",
  "interview_datetime": "ISO 8601 string or null",
  "summary": "One-sentence English summary of what the email says / requests",
  "apply_url": "best job/careers URL from the candidate links, or empty string",
  "interviewer_name": "full name of the interviewer if stated, or empty string"
}`;
}

export class GeminiAnalyzer implements EmailAnalyzer {
  constructor(
    private readonly apiKey = config.gemini.apiKey,
    private readonly model = config.gemini.model,
    private readonly timezone = config.ingest.timezone,
  ) {}

  async analyze(input: EmailInput): Promise<Analysis | null> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not configured");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const payload = {
      contents: [{ parts: [{ text: buildPrompt(input, this.timezone) }] }],
      generationConfig: { responseMimeType: "application/json" },
    };

    // No in-call retry: a 429 here just means "try this thread next run". The
    // poller spaces calls and defers leftovers, so retrying inline only
    // amplifies load against the free-tier rate limit.
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        console.error(`Gemini API error ${res.status}: ${await res.text()}`);
        return null;
      }

      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return null;

      return normalizeAnalysis(JSON.parse(text));
    } catch (err) {
      console.error("Gemini analyze failed:", err);
      return null;
    }
  }
}

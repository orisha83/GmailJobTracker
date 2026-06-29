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
  return `You are an AI assistant helping a Product Manager track job application responses.
Decide if the email is job-application related (interview, phone screening, technical/home assignment, HR conversation, application acknowledgement, or rejection). The email may be in Hebrew or English.

Set "is_relevant" to true for ANY job-application-related email (including acknowledgements and rejections), false for unrelated mail (newsletters, marketing, personal, etc.).

Classify "category" — this is the most important field:
- "Invitation": the email asks the candidate to act NOW — to schedule or attend an interview/phone call/HR meeting, or to complete/submit a home assignment. There is a concrete next step requested of the candidate.
- "Acknowledgement": the email merely confirms the application was received or is under review, or says they will reach out IF/WHEN there is a match. No action is requested of the candidate now. This includes conditional/future language.
- "Rejection": the candidate is not moving forward.
- "Other": job-related but none of the above.

Crucial distinction — conditional/future contact is NOT an invitation:
- "We received your CV and will review it; if there is a match we will contact you for a short phone call." => "Acknowledgement" (NOT "Invitation"), even though it mentions a phone call.
- "We'd like to schedule a 30-minute call this week — what times work for you?" => "Invitation".
- "Please complete the attached assignment by Sunday." => "Invitation".

The email was received at: ${input.emailDate} (timezone ${timezone}).
If the email proposes a specific date/time (including relative phrases like "next Tuesday at 3pm"), resolve it to an absolute ISO 8601 timestamp using the received date above. If no specific time is proposed, use null.

Email Subject: ${input.subject}
Email Body: ${body}

Respond ONLY with a valid JSON object (no markdown fences) using exactly this structure:
{
  "is_relevant": true/false,
  "company": "Company name (translate to English if Hebrew)",
  "role": "Job title or role (translate to English if Hebrew)",
  "type": "Interview" | "Phone Call" | "Home Assignment" | "HR Meeting",
  "category": "Invitation" | "Acknowledgement" | "Rejection" | "Other",
  "interview_datetime": "ISO 8601 string or null",
  "summary": "One-sentence English summary of what the email says / requests"
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

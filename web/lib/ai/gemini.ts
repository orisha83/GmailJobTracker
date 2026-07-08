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

"company": the HIRING company the candidate applied to — take it from the email body/subject/signature (e.g. "the Product Manager position at Blockaid"), NOT the sender's personal name. A recruiter (a person) often sends on behalf of the company; report the company, not the recruiter. Sender hints — name: "${input.senderName ?? ""}", domain: "${input.senderDomain ?? ""}". Translate to English if Hebrew.

Classify "category":
- "Invitation": the email asks the candidate to act NOW — schedule/attend an interview, phone screen, HR conversation, or complete/submit a home assignment. A concrete next step is requested.
- "Applied": acknowledgement only — application received / under review, or "we'll contact you IF there's a match". No action requested now (conditional/future language counts here).
- "Rejection": not moving forward.
- "Offer": a JOB OFFER of employment is being extended — compensation/salary, contract, offer letter, or start-date terms. Offering an interview, a call, or a time slot is NOT an Offer — that is an "Invitation".
- "Other": job-related but none of the above.

"step": a SHORT label (2-4 words) describing this specific step, used as the position's status. Identify the interview round / who it's with when stated, e.g. "HR screen", "Phone screen", "Recruiter call", "Hiring manager interview", "PM interview", "VP interview", "CEO interview", "Technical interview", "Home assignment", "Final round". For Applied use "Applied"; Rejection "Rejected"; Offer "Offer".

"role": the job title the CANDIDATE applied to / is interviewing for — from the position description in the subject/body (e.g. "the Product Manager, Payments position"). NOT the interviewer's, recruiter's, or sender's own job title (e.g. "You'll meet Jane Doe, Director of Product" => Jane Doe is the interviewer, NOT the role). Keep the wording consistent across a thread.

Crucial — conditional/future contact is NOT an invitation:
- "We received your CV; if there's a match we'll contact you for a call." => category "Applied".
- "We'd like to schedule a 30-min call this week — what times work?" => "Invitation", step e.g. "Recruiter call".
- "Please complete the attached assignment by Sunday." => "Invitation", step "Home assignment".

Crucial — the word "offer" around an interview is NOT a job offer:
- "We'd like to offer you an interview slot on Tuesday." => "Invitation", step e.g. "Interview".
- "נשמח להציע לך להתקדם לראיון" => "Invitation".
- "Attached is your offer letter; base salary and start date inside." / "מצורפת הצעת השכר" => "Offer".

The email was received at: ${input.emailDate} (timezone ${timezone}).
"interview_datetime": if a specific date/time is proposed, output the interview's LOCAL time in the candidate's timezone (${timezone}), formatted "YYYY-MM-DDTHH:MM:SS" with NO "Z" and NO timezone offset. Use the time exactly as shown to the candidate in the email; if the email states a different timezone, convert it to ${timezone}. NEVER output UTC or shift the clock time. Resolve relative phrases ("next Tuesday at 3pm") using the received date. If no specific time, null.

"apply_url": from the Candidate links below, choose the SINGLE URL that best points to this specific job posting / application portal / company careers page or site. Ignore unsubscribe, social, login, and tracking links. Use "" if none fits or the list is empty. Output the URL exactly as listed — never invent one.

"interviewer_name": the full name of the person the candidate will interview with / meet, if explicitly stated (e.g. "You'll meet with Jane Doe"). This is the INTERVIEWER, not the recruiter, coordinator, or sender — and NEVER the candidate themselves${config.ingest.candidateName ? ` (the candidate is ${config.ingest.candidateName} — never output that name)` : " (the email's recipient/addressee is the candidate, not an interviewer)"}. Scheduling emails often carry the candidate's own name in titles like "Phone interview — <candidate>"; that is NOT the interviewer. Use "" if no interviewer is clearly named.

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

type CallResult =
  | { kind: "ok"; analysis: Analysis | null }
  | { kind: "retryable"; status: number } // 429/503 — the MODEL is busy, not us
  | { kind: "fatal" };

export class GeminiAnalyzer implements EmailAnalyzer {
  constructor(
    private readonly apiKey = config.gemini.apiKey,
    private readonly model = config.gemini.model,
    private readonly timezone = config.ingest.timezone,
    private readonly fallbackModel = config.gemini.fallbackModel,
  ) {}

  async analyze(input: EmailInput): Promise<Analysis | null> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not configured");
    const prompt = buildPrompt(input, this.timezone);

    const first = await this.callModel(this.model, prompt);
    if (first.kind === "ok") return first.analysis;

    // 429/503 are per-MODEL conditions (each model id has its own capacity and
    // daily allowance), so one hop to a sibling model usually succeeds — an
    // overloaded model must not stall an interview invitation for hours.
    // We never retry the SAME model inline: that only amplifies load against
    // its rate limit; the poller defers and retries next run instead.
    if (first.kind === "retryable" && this.fallbackModel && this.fallbackModel !== this.model) {
      console.error(
        `Gemini ${this.model} unavailable (${first.status}) — trying ${this.fallbackModel}`,
      );
      const second = await this.callModel(this.fallbackModel, prompt);
      if (second.kind === "ok") return second.analysis;
    }
    return null;
  }

  private async callModel(model: string, prompt: string): Promise<CallResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      });

      if (!res.ok) {
        console.error(`Gemini API error ${res.status} (${model}): ${await res.text()}`);
        return res.status === 429 || res.status === 503
          ? { kind: "retryable", status: res.status }
          : { kind: "fatal" };
      }

      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return { kind: "ok", analysis: null };

      return { kind: "ok", analysis: normalizeAnalysis(JSON.parse(text)) };
    } catch (err) {
      console.error(`Gemini analyze failed (${model}):`, err);
      return { kind: "fatal" };
    }
  }
}

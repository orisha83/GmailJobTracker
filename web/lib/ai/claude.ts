/**
 * Claude (Haiku) implementation of EmailAnalyzer. Classifies a job-application
 * email into the lifecycle category + step, extracts the HIRING company (from
 * the body, not the recruiter sender), role, and any interview date/time.
 *
 * Uses structured outputs (`output_config.format`) so the response is guaranteed
 * valid JSON. Haiku does not support `effort`/`thinking` params — omit them.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import {
  type Analysis,
  type EmailAnalyzer,
  type EmailInput,
  normalizeAnalysis,
} from "./analyzer";

const MAX_BODY_CHARS = 4000;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_relevant", "company", "role", "category", "step", "interview_datetime", "summary"],
  properties: {
    is_relevant: { type: "boolean" },
    company: { type: "string" },
    role: { type: "string" },
    category: {
      type: "string",
      enum: ["Invitation", "Applied", "Rejection", "Offer", "Other"],
    },
    step: { type: "string" },
    interview_datetime: { type: "string" }, // local wall-clock "YYYY-MM-DDTHH:MM:SS" (no timezone), or "" if none
    summary: { type: "string" },
  },
} as const;

function buildPrompt(input: EmailInput): string {
  const body = (input.body || "").slice(0, MAX_BODY_CHARS);
  return `You track where a candidate's job applications stand. Analyze ONE email (Hebrew or English) and report the candidate's current step for that position.

Set "is_relevant" false for anything not about this candidate's own job applications (newsletters, marketing, job-alert digests, unrelated mail).

"company": the HIRING company the candidate applied to — take it from the email body/signature (e.g. "the Product Manager position at Blockaid", "Blockaid Talent Team"), NOT the sender's personal name. A recruiter (a person) often sends on behalf of the company; report the company, not the recruiter. Sender hints — name: "${input.senderName ?? ""}", domain: "${input.senderDomain ?? ""}". Translate to English if Hebrew.

"role": the job title (English).

"category":
- "Invitation": asks the candidate to act now — schedule/attend an interview, phone/HR screen, or do a home assignment.
- "Applied": acknowledgement only — application received / under review / "we'll contact you IF there's a match". Conditional/future language ("If you are not selected…") is "Applied", NOT a rejection.
- "Rejection": explicitly not moving forward with the candidate.
- "Offer": an offer is being extended.
- "Other": job-related but none of the above.

"step": a SHORT label (2-4 words) for this email's step, used as the status — identify the round/who when stated: "Applied", "Recruiter call", "HR screen", "Phone interview", "Hiring manager interview", "PM interview", "VP interview", "CEO interview", "Technical interview", "Home assignment", "Final round", "Offer", "Rejected".

"interview_datetime": if a specific date/time is proposed, output it as the interview's LOCAL time in the candidate's timezone (${config.ingest.timezone}), formatted "YYYY-MM-DDTHH:MM:SS" with NO "Z" and NO timezone offset. Use the time exactly as shown to the candidate in the email; if the email states a different timezone, convert it to ${config.ingest.timezone}. Never output UTC. Resolve relative phrases ("tomorrow at 3pm") using the received date ${input.emailDate}. If no specific time, output "".

"summary": one English sentence on what the email says/requests.

Subject: ${input.subject}
Body: ${body}`;
}

export class ClaudeAnalyzer implements EmailAnalyzer {
  private client: Anthropic;
  constructor(
    apiKey = config.anthropic.apiKey,
    private readonly model = config.anthropic.model,
  ) {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
    this.client = new Anthropic({ apiKey });
  }

  async analyze(input: EmailInput): Promise<Analysis | null> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        messages: [{ role: "user", content: buildPrompt(input) }],
      });
      const textBlock = res.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      if (!textBlock) return null;
      const text = textBlock.text;
      return normalizeAnalysis(JSON.parse(text));
    } catch (err) {
      console.error("Claude analyze failed:", err);
      return null;
    }
  }
}

/**
 * Manual updates: things that happen off-email ("they called — they liked the
 * assignment and want to continue"). Each becomes a normal Tracker row on the
 * application's card (source "manual"), so it joins the card's history and the
 * stage-aware status like any email. Pure — validated here, written by
 * POST /api/rows.
 */
import type { NewJobRow } from "@/lib/google/sheets";

export const MANUAL_KINDS = {
  passed: { label: "Passed assignment — next round", category: "Progress", step: "Passed assignment — next round" },
  scheduled: { label: "Interview scheduled", category: "Invitation", step: "Interview scheduled" },
  done: { label: "Interview done", category: "Progress", step: "Interview done" },
  offer: { label: "Offer", category: "Offer", step: "Offer" },
  rejected: { label: "Rejected", category: "Rejection", step: "Rejected" },
  // Status "Withdrawn" (≠ step) reads as a manual terminal status — see
  // REJECTED_STATUS / isManualOverride in lib/positions.ts.
  withdrew: { label: "Withdrew", category: "Other", step: "Withdrew", status: "Withdrawn" },
  custom: { label: "Something else…", category: "", step: "" },
} as const satisfies Record<string, { label: string; category: string; step: string; status?: string }>;
export type ManualKind = keyof typeof MANUAL_KINDS;

// Stage for a free-text update — which column of the pipeline it belongs to.
export const CUSTOM_STAGES = {
  progress: "Progress", // interview stage
  applied: "Applied",
  other: "Other",
} as const;
export type CustomStage = keyof typeof CUSTOM_STAGES;

export interface ManualInput {
  company: string;
  companyKey: string;
  role: string;
  threadId: string; // the card's latest thread — keeps the row on that card
  kind: string;
  text?: string; // custom label (kind "custom")
  stage?: string; // custom stage (kind "custom")
  received: string; // ISO timestamp the update happened
  interviewDateTime?: string; // "YYYY-MM-DDTHH:MM" wall-clock (kind "scheduled")
  interviewer?: string;
  note?: string;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validated input → a Tracker row, or the list of problems. */
export function buildManualRow(
  input: Partial<Record<keyof ManualInput, unknown>>,
  messageId: string,
  now = new Date(),
): { row: NewJobRow } | { errors: string[] } {
  const errors: string[] = [];
  const kind = str(input.kind, 20) as ManualKind;
  const preset = MANUAL_KINDS[kind];
  if (!preset) errors.push(`kind must be one of: ${Object.keys(MANUAL_KINDS).join(", ")}`);

  const company = str(input.company, 100);
  const companyKey = str(input.companyKey, 80);
  const threadId = str(input.threadId, 100);
  if (!company || !companyKey) errors.push("company and companyKey are required");
  if (!threadId) errors.push("threadId is required");

  const received = str(input.received, 40);
  const receivedMs = Date.parse(received);
  if (!received || isNaN(receivedMs)) errors.push("received must be an ISO date");
  else if (receivedMs > now.getTime() + 86_400_000) errors.push("received can't be in the future");

  let category: string = preset?.category ?? "";
  let step: string = preset?.step ?? "";
  if (kind === "custom") {
    step = str(input.text, 60);
    category = CUSTOM_STAGES[str(input.stage, 20) as CustomStage] ?? "";
    if (!step) errors.push("text is required for a custom update");
    if (!category) errors.push(`stage must be one of: ${Object.keys(CUSTOM_STAGES).join(", ")}`);
  }

  const interviewDateTime = str(input.interviewDateTime, 19);
  if (interviewDateTime && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(interviewDateTime)) {
    errors.push("interviewDateTime must be YYYY-MM-DDTHH:MM");
  }
  if (errors.length) return { errors };

  const note = str(input.note, 300);
  return {
    row: {
      received: new Date(receivedMs).toISOString(),
      company,
      companyKey,
      role: str(input.role, 100),
      step,
      category,
      interviewDateTime: interviewDateTime ? interviewDateTime.slice(0, 16) + ":00" : "",
      summary: note || `${step} (added manually)`,
      status: preset && "status" in preset ? preset.status : step,
      source: "manual",
      threadId,
      link: "",
      interviewer: str(input.interviewer, 80),
      messageId,
    },
  };
}

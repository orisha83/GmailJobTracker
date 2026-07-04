import { describe, it, expect } from "vitest";
import {
  guardOfferDowngrade,
  normalizeAnalysis,
  stripSelfInterviewer,
  type Analysis,
} from "./analyzer";

describe("normalizeAnalysis", () => {
  it("returns null for non-objects", () => {
    expect(normalizeAnalysis(null)).toBeNull();
    expect(normalizeAnalysis("nope")).toBeNull();
    expect(normalizeAnalysis(42)).toBeNull();
  });

  it("returns null when is_relevant is missing/not a boolean", () => {
    expect(normalizeAnalysis({})).toBeNull();
    expect(normalizeAnalysis({ is_relevant: "true" })).toBeNull();
  });

  it("coerces an invalid category to 'Other'", () => {
    const a = normalizeAnalysis({ is_relevant: true, category: "Bogus" });
    expect(a?.category).toBe("Other");
  });

  it("fills a missing step from the category default", () => {
    expect(normalizeAnalysis({ is_relevant: true, category: "Rejection" })?.step).toBe("Rejected");
    expect(normalizeAnalysis({ is_relevant: true, category: "Invitation" })?.step).toBe("Interview");
    expect(normalizeAnalysis({ is_relevant: true, category: "Offer" })?.step).toBe("Offer");
    expect(normalizeAnalysis({ is_relevant: true })?.step).toBe("Update"); // category → "Other"
  });

  it("drops a non-http apply_url but keeps a valid one", () => {
    expect(normalizeAnalysis({ is_relevant: true, apply_url: "not-a-url" })?.apply_url).toBe("");
    expect(normalizeAnalysis({ is_relevant: true, apply_url: "https://acme.com/jobs" })?.apply_url).toBe(
      "https://acme.com/jobs",
    );
  });

  it("defaults company/role to 'Unknown' and blank interview_datetime to null", () => {
    const a = normalizeAnalysis({ is_relevant: true, interview_datetime: "   " });
    expect(a?.company).toBe("Unknown");
    expect(a?.role).toBe("Unknown");
    expect(a?.interview_datetime).toBeNull();
  });

  it("passes through a fully-specified relevant analysis", () => {
    const a = normalizeAnalysis({
      is_relevant: true,
      company: "Acme",
      role: "Product Manager",
      category: "Invitation",
      step: "HR screen",
      interview_datetime: "2026-07-05T14:00:00.000Z",
      summary: "Recruiter wants to schedule an HR screen.",
      apply_url: "https://acme.com/careers/pm",
      interviewer_name: "Jane Doe",
    });
    expect(a).toEqual({
      is_relevant: true,
      company: "Acme",
      role: "Product Manager",
      category: "Invitation",
      step: "HR screen",
      interview_datetime: "2026-07-05T14:00:00.000Z",
      summary: "Recruiter wants to schedule an HR screen.",
      apply_url: "https://acme.com/careers/pm",
      interviewer_name: "Jane Doe",
    });
  });
});

describe("stripSelfInterviewer — the candidate is never their own interviewer", () => {
  const base: Analysis = {
    is_relevant: true,
    company: "Kela",
    role: "Product Manager",
    category: "Invitation",
    step: "Phone interview",
    interview_datetime: "2026-07-02T12:00:00",
    summary: "",
    apply_url: "",
    interviewer_name: "Ori Shalom",
  };

  it("blanks the interviewer when it is the candidate (case-insensitive)", () => {
    expect(stripSelfInterviewer(base, "Ori Shalom").interviewer_name).toBe("");
    expect(stripSelfInterviewer(base, "ori shalom").interviewer_name).toBe("");
  });

  it("keeps a real interviewer", () => {
    const a = stripSelfInterviewer({ ...base, interviewer_name: "Eran Strauchler" }, "Ori Shalom");
    expect(a.interviewer_name).toBe("Eran Strauchler");
  });

  it("is a no-op when CANDIDATE_NAME is not configured", () => {
    expect(stripSelfInterviewer(base, "").interviewer_name).toBe("Ori Shalom");
  });
});

describe("guardOfferDowngrade — 'offer you an interview' is not a job offer", () => {
  function offer(partial: Partial<Analysis> = {}): Analysis {
    return {
      is_relevant: true,
      company: "AppsFlyer",
      role: "Product Manager",
      category: "Offer",
      step: "Offer",
      interview_datetime: "2026-07-06T12:00:00",
      summary: "",
      apply_url: "",
      interviewer_name: "",
      ...partial,
    };
  }

  it("downgrades Offer + interview time + no compensation language to Invitation", () => {
    const a = guardOfferDowngrade(
      offer(),
      "Interview slot\nWe'd like to offer you an interview slot on Monday at noon.",
    );
    expect(a.category).toBe("Invitation");
    expect(a.step).toBe("Interview"); // "Offer" step replaced too
  });

  it("downgrades the Hebrew interview-slot phrasing", () => {
    const a = guardOfferDowngrade(offer(), "נשמח להציע לך להתקדם לראיון ביום שלישי בשעה 12:00");
    expect(a.category).toBe("Invitation");
  });

  it("keeps a real offer that talks compensation, even with a meeting time", () => {
    const a = guardOfferDowngrade(
      offer(),
      "Your offer letter\nAttached is your offer letter — base salary and equity inside. Let's sign on Monday at 10:00.",
    );
    expect(a.category).toBe("Offer");
    expect(a.step).toBe("Offer");
  });

  it("keeps a Hebrew salary offer", () => {
    const a = guardOfferDowngrade(offer(), "מצורפת הצעת שכר לתפקיד. נשמח לשיחה ביום שני.");
    expect(a.category).toBe("Offer");
  });

  it("leaves an Offer without a scheduled interview time alone", () => {
    const a = guardOfferDowngrade(offer({ interview_datetime: null }), "We are pleased to make you an offer.");
    expect(a.category).toBe("Offer");
  });

  it("keeps a model-specific step when downgrading (only 'Offer'-ish steps are replaced)", () => {
    const a = guardOfferDowngrade(
      offer({ step: "Hiring manager interview" }),
      "We'd like to offer you a slot for the hiring manager interview on Tuesday.",
    );
    expect(a.category).toBe("Invitation");
    expect(a.step).toBe("Hiring manager interview");
  });

  it("never touches non-Offer categories", () => {
    const a = guardOfferDowngrade(offer({ category: "Invitation", step: "HR screen" }), "anything");
    expect(a.category).toBe("Invitation");
    expect(a.step).toBe("HR screen");
  });
});

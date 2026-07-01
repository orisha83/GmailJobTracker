import { describe, it, expect } from "vitest";
import { normalizeAnalysis } from "./analyzer";

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

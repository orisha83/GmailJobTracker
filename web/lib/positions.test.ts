import { describe, it, expect } from "vitest";
import { buildPositions, derivePositionState, type Job } from "./positions";

/** Row builder. Auto rows always have status === step (like ingestion writes
 *  them); pass `status` explicitly to simulate a manual override. */
function job(partial: Partial<Job>): Job {
  const step = partial.step ?? "Applied";
  return {
    received: "2026-07-01T09:00:00.000Z",
    company: "Acme",
    companyKey: "acme",
    role: "Product Manager",
    category: "Applied",
    interviewDateTime: "",
    summary: "",
    source: "rule",
    threadId: "t1",
    link: "",
    interviewer: "",
    messageId: "m1",
    ...partial,
    step,
    status: partial.status ?? step,
  };
}

const FUTURE = "2099-07-06T12:00:00";

describe("derivePositionState — stage-aware status", () => {
  it("keeps the interview step when an ack arrives AFTER the invitation (Kela bug)", () => {
    const s = derivePositionState([
      job({ messageId: "m1", received: "2026-06-20T09:00:00.000Z", category: "Applied", step: "Applied" }),
      job({
        messageId: "m2",
        received: "2026-06-25T09:00:00.000Z",
        category: "Invitation",
        step: "HR screen",
        interviewDateTime: FUTURE,
      }),
      job({ messageId: "m3", received: "2026-07-01T09:00:00.000Z", category: "Applied", step: "Applied" }),
    ]);
    expect(s.status).toBe("HR screen");
    expect(s.category).toBe("Invitation");
    expect(s.statusSource).toBe("derived");
  });

  it("uses the LATEST invitation's step when several rounds exist", () => {
    const s = derivePositionState([
      job({ messageId: "m1", received: "2026-06-20T09:00:00.000Z", category: "Invitation", step: "HR screen" }),
      job({ messageId: "m2", received: "2026-06-28T09:00:00.000Z", category: "Invitation", step: "VP interview" }),
      job({ messageId: "m3", received: "2026-07-01T09:00:00.000Z", category: "Other", step: "Update" }),
    ]);
    expect(s.status).toBe("VP interview");
  });

  it("a genuine Offer survives a later ack/update", () => {
    const s = derivePositionState([
      job({ messageId: "m1", received: "2026-06-25T09:00:00.000Z", category: "Offer", step: "Offer" }),
      job({ messageId: "m2", received: "2026-07-01T09:00:00.000Z", category: "Other", step: "Update" }),
    ]);
    expect(s.status).toBe("Offer");
    expect(s.category).toBe("Offer");
  });

  it("a rejection is terminal regardless of other rows", () => {
    const s = derivePositionState([
      job({ messageId: "m1", received: "2026-06-25T09:00:00.000Z", category: "Invitation", step: "HR screen" }),
      job({ messageId: "m2", received: "2026-07-01T09:00:00.000Z", category: "Rejection", step: "Rejected" }),
    ]);
    expect(s.status).toBe("Rejected");
    expect(s.category).toBe("Rejection");
  });

  it("shows 'Interview scheduled' when an upcoming time exists without an Invitation row", () => {
    const s = derivePositionState([
      job({
        messageId: "m1",
        category: "Applied",
        step: "Applied",
        interviewDateTime: FUTURE,
      }),
    ]);
    expect(s.status).toBe("Interview scheduled");
    expect(s.category).toBe("Invitation");
  });

  it("ack-only position stays Applied", () => {
    const s = derivePositionState([job({ category: "Applied", step: "Applied" })]);
    expect(s.status).toBe("Applied");
    expect(s.category).toBe("Applied");
  });

  it("a past interview time alone does not fake an upcoming interview", () => {
    const s = derivePositionState([
      job({ category: "Applied", step: "Applied", interviewDateTime: "2020-01-01T10:00:00" }),
    ]);
    expect(s.status).toBe("Applied");
  });
});

describe("derivePositionState — manual override precedence", () => {
  it("manual status on the latest row wins", () => {
    const s = derivePositionState([
      job({ messageId: "m1", received: "2026-06-25T09:00:00.000Z", category: "Invitation", step: "HR screen" }),
      job({
        messageId: "m2",
        received: "2026-07-01T09:00:00.000Z",
        category: "Applied",
        step: "Applied",
        status: "Interviewing", // user override on the latest row
      }),
    ]);
    expect(s.status).toBe("Interviewing");
    expect(s.category).toBe("Invitation");
    expect(s.statusSource).toBe("manual");
  });

  it("newer email evidence supersedes a manual override on an OLDER row", () => {
    const s = derivePositionState([
      job({
        messageId: "m1",
        received: "2026-06-25T09:00:00.000Z",
        category: "Applied",
        step: "Applied",
        status: "Interviewing", // stale manual override
      }),
      job({
        messageId: "m2",
        received: "2026-07-01T09:00:00.000Z",
        category: "Invitation",
        step: "VP interview",
      }),
    ]);
    expect(s.status).toBe("VP interview");
    expect(s.statusSource).toBe("derived");
  });

  it("manual terminal status (Withdrawn) sticks even on an older row", () => {
    const s = derivePositionState([
      job({
        messageId: "m1",
        received: "2026-06-25T09:00:00.000Z",
        category: "Applied",
        step: "Applied",
        status: "Withdrawn",
      }),
    ]);
    expect(s.status).toBe("Withdrawn");
    expect(s.statusSource).toBe("manual");
  });
});

describe("buildPositions — segmentation still works with derived status", () => {
  it("splits a company card at a rejection; a later re-apply starts fresh", () => {
    const rows = [
      job({ messageId: "m1", threadId: "t1", received: "2026-05-01T09:00:00.000Z" }),
      job({
        messageId: "m2",
        threadId: "t1",
        received: "2026-05-10T09:00:00.000Z",
        category: "Rejection",
        step: "Rejected",
      }),
      job({ messageId: "m3", threadId: "t2", received: "2026-06-20T09:00:00.000Z" }),
    ];
    const positions = buildPositions(rows);
    expect(positions).toHaveLength(2);
    const statuses = positions.map((p) => p.status).sort();
    expect(statuses).toEqual(["Applied", "Rejected"]);
  });

  it("exposes latestMessageId for the manual-override PATCH target", () => {
    const positions = buildPositions([
      job({ messageId: "m1", received: "2026-06-20T09:00:00.000Z" }),
      job({ messageId: "m2", received: "2026-07-01T09:00:00.000Z" }),
    ]);
    expect(positions[0].latestMessageId).toBe("m2");
  });

  it("surfaces the upcoming interview drawn from an older email", () => {
    const positions = buildPositions([
      job({
        messageId: "m1",
        received: "2026-06-25T09:00:00.000Z",
        category: "Invitation",
        step: "HR screen",
        interviewDateTime: FUTURE,
      }),
      job({ messageId: "m2", received: "2026-07-01T09:00:00.000Z" }),
    ]);
    expect(positions[0].nextInterview).toBe(FUTURE);
    expect(positions[0].status).toBe("HR screen");
  });
});

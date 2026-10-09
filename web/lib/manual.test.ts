import { describe, it, expect } from "vitest";
import { buildManualRow } from "./manual";
import { buildPositions, type Job } from "./positions";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const base = {
  company: "mPrest",
  companyKey: "mprest",
  role: "Product Maker",
  threadId: "t-hen",
  received: "2026-10-09T09:30:00.000Z",
};
const build = (extra: Record<string, unknown>) => buildManualRow({ ...base, ...extra }, "manual-1", NOW);

describe("buildManualRow", () => {
  it("'Passed assignment — next round' → a Progress row on the card's thread", () => {
    const r = build({ kind: "passed", note: "Hen called — they liked it" });
    expect(r).toEqual({
      row: expect.objectContaining({
        category: "Progress",
        step: "Passed assignment — next round",
        status: "Passed assignment — next round",
        source: "manual",
        threadId: "t-hen",
        messageId: "manual-1",
        summary: "Hen called — they liked it",
      }),
    });
  });

  it("'Interview scheduled' carries the wall-clock time and interviewer", () => {
    const r = build({ kind: "scheduled", interviewDateTime: "2026-10-14T15:30", interviewer: "Dana Levi" });
    expect("row" in r && r.row).toMatchObject({
      category: "Invitation",
      interviewDateTime: "2026-10-14T15:30:00",
      interviewer: "Dana Levi",
    });
  });

  it("'Withdrew' is a terminal manual status", () => {
    const r = build({ kind: "withdrew" });
    expect("row" in r && r.row).toMatchObject({ step: "Withdrew", status: "Withdrawn" });
  });

  it("custom text needs a label and a stage", () => {
    expect(build({ kind: "custom" })).toEqual({ errors: expect.arrayContaining([expect.stringMatching(/text/), expect.stringMatching(/stage/)]) });
    const r = build({ kind: "custom", text: "Spoke with CEO", stage: "progress" });
    expect("row" in r && r.row).toMatchObject({ step: "Spoke with CEO", category: "Progress" });
  });

  it("rejects unknown kinds, missing card ids, bad and future dates", () => {
    expect(build({ kind: "nope" })).toHaveProperty("errors");
    expect(buildManualRow({ kind: "passed", received: base.received }, "m", NOW)).toHaveProperty("errors");
    expect(build({ kind: "passed", received: "yesterday" })).toHaveProperty("errors");
    expect(build({ kind: "passed", received: "2026-12-01T00:00:00.000Z" })).toHaveProperty("errors");
    expect(build({ kind: "scheduled", interviewDateTime: "next tuesday" })).toHaveProperty("errors");
  });
});

describe("manual + sent rows drive the card", () => {
  const row = (p: Partial<Job>): Job => ({
    received: "", company: "mPrest", companyKey: "mprest", role: "Product Maker", step: "", category: "",
    interviewDateTime: "", summary: "", source: "ai", threadId: "t-hen", link: "", interviewer: "",
    messageId: "", ...p, status: p.status ?? p.step ?? "",
  });

  it("Home assignment → Assignment submitted → Passed (manual): latest stage wins, with its date", () => {
    const manual = buildManualRow({ ...base, kind: "passed" }, "manual-1", NOW);
    if (!("row" in manual)) throw new Error("expected row");
    const ps = buildPositions([
      row({ messageId: "1", received: "2026-10-01T00:00:00.000Z", category: "Invitation", step: "Home assignment" }),
      row({ messageId: "2", received: "2026-10-06T10:00:00.000Z", category: "Progress", step: "Assignment submitted", source: "sent" }),
      manual.row,
    ]);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({
      status: "Passed assignment — next round",
      category: "Progress",
      statusDate: "2026-10-09T09:30:00.000Z",
    });
  });

  it("a later invitation from the company supersedes 'Assignment submitted'", () => {
    const ps = buildPositions([
      row({ messageId: "2", received: "2026-10-06T10:00:00.000Z", category: "Progress", step: "Assignment submitted" }),
      row({ messageId: "3", received: "2026-10-08T10:00:00.000Z", category: "Invitation", step: "Final round" }),
    ]);
    expect(ps[0]).toMatchObject({ status: "Final round", category: "Invitation", statusDate: "2026-10-08T10:00:00.000Z" });
  });

  it("'Assignment submitted' isn't downgraded by a later ack", () => {
    const ps = buildPositions([
      row({ messageId: "2", received: "2026-10-06T10:00:00.000Z", category: "Progress", step: "Assignment submitted" }),
      row({ messageId: "3", received: "2026-10-07T10:00:00.000Z", category: "Applied", step: "Applied" }),
    ]);
    expect(ps[0].status).toBe("Assignment submitted");
  });
});

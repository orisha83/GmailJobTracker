import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Analysis, EmailAnalyzer } from "@/lib/ai/analyzer";
import type { RawEmail, TrackedJob } from "@/lib/google/sheets";

vi.mock("@/lib/config", () => ({
  config: {
    ingest: { searchQuery: "Q", startDate: "2026/01/01", maxPerRun: 25, throttleMs: 0 },
    sheets: { dataSheet: "Tracker", rawSheet: "Raw" },
  },
}));
vi.mock("@/lib/ai", () => ({ getAnalyzer: () => ({ analyze: vi.fn() }) }));
vi.mock("@/lib/google/auth", () => ({ makeAuthedClient: () => ({}) }));
vi.mock("@/lib/google/gmail", () => ({
  fetchMessage: vi.fn(),
  listThreadMessageIds: vi.fn(),
}));
vi.mock("@/lib/google/sheets", () => ({
  ensureSheets: vi.fn(),
  readRows: vi.fn(),
  readRawEmails: vi.fn(),
  appendRawEmails: vi.fn(),
  batchUpdateValues: vi.fn(),
}));

import { runReprocess } from "./reprocess";
import { fetchMessage, listThreadMessageIds } from "@/lib/google/gmail";
import {
  appendRawEmails,
  batchUpdateValues,
  readRawEmails,
  readRows,
} from "@/lib/google/sheets";

/** Tracker row builder (auto rows: status === step). */
function row(partial: Partial<TrackedJob>): TrackedJob {
  const step = partial.step ?? "Applied";
  return {
    rowNumber: 2,
    received: "2026-07-01T09:00:00.000Z",
    company: "AppsFlyer",
    companyKey: "appsflyer",
    role: "Product Manager",
    category: "Applied",
    interviewDateTime: "",
    summary: "",
    source: "ai",
    threadId: "t1",
    link: "",
    interviewer: "",
    messageId: "m1",
    ...partial,
    step,
    status: partial.status ?? step,
  };
}

function raw(partial: Partial<RawEmail>): RawEmail {
  return {
    messageId: "m1",
    threadId: "t1",
    received: "2026-07-01T09:00:00.000Z",
    senderName: "AppsFlyer Recruiting",
    senderDomain: "appsflyer.com",
    subject: "Next steps",
    body: "We'd like to offer you an interview slot on Monday at 12:00.",
    links: [],
    ...partial,
  };
}

function spyAnalyzer(results: (Analysis | null)[]): EmailAnalyzer & { analyze: ReturnType<typeof vi.fn> } {
  const analyze = vi.fn();
  for (const r of results) analyze.mockResolvedValueOnce(r);
  return { analyze };
}

const invitation: Analysis = {
  is_relevant: true,
  company: "AppsFlyer",
  role: "Product Manager",
  category: "Invitation",
  step: "Hiring manager interview",
  interview_datetime: "2026-07-06T12:00:00",
  summary: "",
  apply_url: "",
  interviewer_name: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readRows).mockResolvedValue([]);
  vi.mocked(readRawEmails).mockResolvedValue(new Map());
  vi.mocked(fetchMessage).mockResolvedValue(null);
  vi.mocked(listThreadMessageIds).mockResolvedValue([]);
});

describe("runReprocess — diff detection", () => {
  it("detects a false Offer and reports category/step/status corrections (AppsFlyer regression)", async () => {
    vi.mocked(readRows).mockResolvedValue([
      row({ category: "Offer", step: "Offer", interviewDateTime: "2026-07-06T12:00:00" }),
    ]);
    vi.mocked(readRawEmails).mockResolvedValue(new Map([["m1", raw({})]]));

    const report = await runReprocess({ dryRun: true }, spyAnalyzer([invitation]));

    expect(report.done).toBe(true);
    const fields = report.changes.map((c) => `${c.field}:${c.newValue}`).sort();
    expect(fields).toEqual([
      "category:Invitation",
      "status:Hiring manager interview",
      "step:Hiring manager interview",
    ]);
    expect(batchUpdateValues).not.toHaveBeenCalled(); // dry run writes nothing
  });

  it("reports no changes when the classification already matches", async () => {
    vi.mocked(readRows).mockResolvedValue([
      row({
        category: "Invitation",
        step: "Hiring manager interview",
        interviewDateTime: "2026-07-06T12:00:00",
      }),
    ]);
    vi.mocked(readRawEmails).mockResolvedValue(new Map([["m1", raw({})]]));

    const report = await runReprocess({ dryRun: true }, spyAnalyzer([invitation]));

    expect(report.changes).toEqual([]);
    expect(report.reclassified).toBe(1);
  });
});

describe("runReprocess — apply semantics", () => {
  it("writes E:G and Status (unedited row) in one batch", async () => {
    vi.mocked(readRows).mockResolvedValue([
      row({ rowNumber: 7, category: "Offer", step: "Offer", interviewDateTime: "" }),
    ]);
    vi.mocked(readRawEmails).mockResolvedValue(new Map([["m1", raw({})]]));

    await runReprocess({ dryRun: false }, spyAnalyzer([invitation]));

    const updates = vi.mocked(batchUpdateValues).mock.calls[0][1];
    expect(updates).toEqual([
      {
        range: "Tracker!E7:G7",
        values: [["Hiring manager interview", "Invitation", "2026-07-06T12:00:00"]],
      },
      { range: "Tracker!I7", values: [["Hiring manager interview"]] },
    ]);
  });

  it("never touches a manually-edited Status", async () => {
    vi.mocked(readRows).mockResolvedValue([
      row({ rowNumber: 4, category: "Offer", step: "Offer", status: "Interviewing" }), // user edit
    ]);
    vi.mocked(readRawEmails).mockResolvedValue(new Map([["m1", raw({})]]));

    const report = await runReprocess({ dryRun: false }, spyAnalyzer([invitation]));

    const updates = vi.mocked(batchUpdateValues).mock.calls[0][1];
    expect(updates.map((u) => u.range)).toEqual(["Tracker!E4:G4"]); // no I4
    expect(report.changes.some((c) => c.field === "status")).toBe(false);
  });

  it("a rule 'Applied' never downgrades an AI Invitation row (Kela protection)", async () => {
    vi.mocked(readRows).mockResolvedValue([
      row({
        category: "Invitation",
        step: "Phone interview",
        interviewDateTime: "2026-07-02T12:00:00",
      }),
    ]);
    // Pure ack text → rules classify Applied; the original AI saw more context.
    vi.mocked(readRawEmails).mockResolvedValue(
      new Map([["m1", raw({ subject: "Thanks", body: "Thank you for applying to KELA." })]]),
    );
    const analyzer = spyAnalyzer([invitation]);

    const report = await runReprocess({ dryRun: false }, analyzer);

    expect(analyzer.analyze).not.toHaveBeenCalled(); // rules matched
    expect(report.changes).toEqual([]);
    expect(vi.mocked(batchUpdateValues).mock.calls[0][1]).toEqual([]);
  });

  it("a rule result never clears an interview datetime the AI found", async () => {
    vi.mocked(readRows).mockResolvedValue([
      row({
        category: "Applied",
        step: "Application received",
        interviewDateTime: "2026-07-09T10:00:00",
      }),
    ]);
    vi.mocked(readRawEmails).mockResolvedValue(
      new Map([["m1", raw({ subject: "Thanks", body: "Thank you for applying." })]]),
    );

    const report = await runReprocess({ dryRun: false }, spyAnalyzer([invitation]));

    // Step label may normalize, but the datetime column is untouched.
    expect(report.changes.some((c) => c.field === "interviewDateTime")).toBe(false);
    const ranges = vi.mocked(batchUpdateValues).mock.calls[0][1];
    const efg = ranges.find((u) => u.range.startsWith("Tracker!E"));
    expect(efg?.values[0][2]).toBe("2026-07-09T10:00:00"); // G preserved
  });

  it("a rule 'Rejected' still corrects a missed rejection", async () => {
    vi.mocked(readRows).mockResolvedValue([row({ category: "Applied", step: "Applied" })]);
    vi.mocked(readRawEmails).mockResolvedValue(
      new Map([
        ["m1", raw({ subject: "Update", body: "Unfortunately we are moving forward with other candidates." })],
      ]),
    );

    const report = await runReprocess({ dryRun: true }, spyAnalyzer([invitation]));

    expect(report.changes.map((c) => `${c.field}:${c.newValue}`).sort()).toEqual([
      "category:Rejection",
      "status:Rejected",
      "step:Rejected",
    ]);
  });

  it("leaves rows without interview signal untouched (rules and gate say skip)", async () => {
    vi.mocked(readRows).mockResolvedValue([row({})]);
    vi.mocked(readRawEmails).mockResolvedValue(
      new Map([["m1", raw({ subject: "Hello", body: "Just checking in about the weather." })]]),
    );
    const analyzer = spyAnalyzer([invitation]);

    const report = await runReprocess({ dryRun: false }, analyzer);

    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(report.changes).toEqual([]);
  });
});

describe("runReprocess — resumability", () => {
  it("stops at the AI budget and reports nextRow", async () => {
    vi.mocked(readRows).mockResolvedValue([
      row({ rowNumber: 2, messageId: "m1" }),
      row({ rowNumber: 3, messageId: "m2", threadId: "t2" }),
    ]);
    vi.mocked(readRawEmails).mockResolvedValue(
      new Map([
        ["m1", raw({ messageId: "m1" })],
        ["m2", raw({ messageId: "m2", threadId: "t2" })],
      ]),
    );

    const report = await runReprocess({ dryRun: true, limit: 1 }, spyAnalyzer([invitation]));

    expect(report.done).toBe(false);
    expect(report.nextRow).toBe(3);
    expect(report.aiCalls).toBe(1);
  });

  it("startRow skips rows already covered by a previous pass", async () => {
    vi.mocked(readRows).mockResolvedValue([
      row({ rowNumber: 2, messageId: "m1" }),
      row({ rowNumber: 3, messageId: "m2", threadId: "t2" }),
    ]);
    vi.mocked(readRawEmails).mockResolvedValue(
      new Map([
        ["m1", raw({ messageId: "m1" })],
        ["m2", raw({ messageId: "m2", threadId: "t2" })],
      ]),
    );
    const analyzer = spyAnalyzer([invitation]);

    const report = await runReprocess({ dryRun: true, startRow: 3 }, analyzer);

    expect(report.rowsExamined).toBe(1);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    expect(report.done).toBe(true);
  });
});

describe("runReprocess — raw backfill from Gmail", () => {
  it("recovers an uncached body by thread + received time and caches it", async () => {
    vi.mocked(readRows).mockResolvedValue([row({ messageId: "" })]); // pre-migration row
    vi.mocked(readRawEmails).mockResolvedValue(new Map());
    vi.mocked(listThreadMessageIds).mockResolvedValue([
      { messageId: "m-found", internalDate: "2026-07-01T09:00:00.000Z" },
    ]);
    vi.mocked(fetchMessage).mockResolvedValue({
      id: "m-found",
      threadId: "t1",
      subject: "Next steps",
      body: "We'd like to offer you an interview slot on Monday at 12:00.",
      date: "2026-07-01T09:00:00.000Z",
      senderName: "AppsFlyer Recruiting",
      senderDomain: "appsflyer.com",
      links: [],
      isSelfNotification: false,
    });

    const report = await runReprocess({ dryRun: true }, spyAnalyzer([invitation]));

    expect(report.backfilledRaw).toBe(1);
    expect(report.skippedNoRaw).toBe(0);
    const cached = vi.mocked(appendRawEmails).mock.calls[0][1];
    expect(cached[0].messageId).toBe("m-found");
  });

  it("counts a row as unrecoverable when Gmail has no matching message", async () => {
    vi.mocked(readRows).mockResolvedValue([row({ messageId: "" })]);
    vi.mocked(readRawEmails).mockResolvedValue(new Map());
    vi.mocked(listThreadMessageIds).mockResolvedValue([]);

    const report = await runReprocess({ dryRun: true }, spyAnalyzer([invitation]));

    expect(report.skippedNoRaw).toBe(1);
    expect(report.changes).toEqual([]);
  });
});

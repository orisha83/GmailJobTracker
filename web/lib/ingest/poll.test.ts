import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FetchedMessage } from "@/lib/google/gmail";
import type { Analysis, EmailAnalyzer } from "@/lib/ai/analyzer";

// Deterministic config: no throttle sleeps, generous cap.
vi.mock("@/lib/config", () => ({
  config: { ingest: { searchQuery: "Q", startDate: "2026/01/01", maxPerRun: 25, throttleMs: 0 } },
}));
// Avoid loading the real analyzers (and the Anthropic SDK); we always inject a spy.
vi.mock("@/lib/ai", () => ({ getAnalyzer: () => ({ analyze: vi.fn() }) }));
vi.mock("@/lib/google/auth", () => ({ makeAuthedClient: () => ({}) }));
vi.mock("@/lib/google/gmail", () => ({ searchThreads: vi.fn(), fetchMessage: vi.fn() }));
vi.mock("@/lib/google/sheets", () => ({
  ensureSheets: vi.fn(),
  getLastChecked: vi.fn(),
  getProcessedThreadIds: vi.fn(),
  markProcessedBatch: vi.fn(),
  appendRows: vi.fn(),
  setLastChecked: vi.fn(),
}));
vi.mock("@/lib/notify", () => ({ notifyDigest: vi.fn() }));

import { runPoll } from "./poll";
import { searchThreads, fetchMessage } from "@/lib/google/gmail";
import {
  appendRows,
  getLastChecked,
  getProcessedThreadIds,
  markProcessedBatch,
  setLastChecked,
} from "@/lib/google/sheets";
import { notifyDigest } from "@/lib/notify";

/** Minimal FetchedMessage builder. */
function fm(partial: Partial<FetchedMessage>): FetchedMessage {
  return {
    id: "m",
    subject: "",
    body: "",
    date: "2026-07-01T09:00:00.000Z",
    senderName: "",
    senderDomain: "",
    links: [],
    isSelfNotification: false,
    ...partial,
  };
}

/** Minimal Analysis builder (relevant by default). */
function an(partial: Partial<Analysis>): Analysis {
  return {
    is_relevant: true,
    company: "Acme",
    role: "Product Manager",
    category: "Invitation",
    step: "HR screen",
    interview_datetime: null,
    summary: "",
    apply_url: "",
    interviewer_name: "",
    ...partial,
  };
}

/** Wires searchThreads → the given messages and fetchMessage → lookup by id. */
function feed(messages: FetchedMessage[]): void {
  vi.mocked(searchThreads).mockResolvedValue(
    messages.map((m) => ({ threadId: `t-${m.id}`, latestMessageId: m.id })),
  );
  const byId = new Map(messages.map((m) => [m.id, m]));
  vi.mocked(fetchMessage).mockImplementation(async (_auth, id) => byId.get(id) ?? null);
}

/** An analyzer spy that always returns the given analysis (or null). */
function spyAnalyzer(result: Analysis | null): EmailAnalyzer & { analyze: ReturnType<typeof vi.fn> } {
  return { analyze: vi.fn().mockResolvedValue(result) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProcessedThreadIds).mockResolvedValue(new Set());
  vi.mocked(getLastChecked).mockResolvedValue(1_000_000);
  vi.mocked(searchThreads).mockResolvedValue([]);
  vi.mocked(fetchMessage).mockResolvedValue(null);
});

describe("runPoll — self-notification backstop (commit 7fe53e1)", () => {
  it("skips our own digest email: no AI, no row, no alert, but marked processed", async () => {
    feed([fm({ id: "m1", isSelfNotification: true, subject: "🚨 Job Agent: 2 updates", body: "..." })]);
    const analyzer = spyAnalyzer(an({}));

    const result = await runPoll(analyzer);

    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(vi.mocked(appendRows).mock.calls[0][1]).toEqual([]); // no rows appended
    expect(vi.mocked(notifyDigest).mock.calls[0][1]).toEqual([]); // no alerts queued
    expect(vi.mocked(markProcessedBatch).mock.calls[0][1]).toEqual(["t-m1"]); // still marked
    expect(result.skipped).toBe(1);
    expect(result.relevant).toBe(0);
  });
});

describe("runPoll — AI path", () => {
  it("analyzes an invitation, appends a row (source ai) and queues a digest alert", async () => {
    feed([
      fm({
        id: "m2",
        subject: "Interview invitation",
        body: "We'd like to invite you to an interview. Please share your availability.",
        senderName: "Acme Recruiting",
        senderDomain: "acme.com",
      }),
    ]);
    const analyzer = spyAnalyzer(an({ company: "Acme", category: "Invitation", step: "HR screen" }));

    const result = await runPoll(analyzer);

    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    const rows = vi.mocked(appendRows).mock.calls[0][1];
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("ai");
    expect(rows[0].company).toBe("Acme");
    const alerts = vi.mocked(notifyDigest).mock.calls[0][1];
    expect(alerts).toHaveLength(1);
    expect(result.invitations).toBe(1);
    expect(vi.mocked(markProcessedBatch).mock.calls[0][1]).toEqual(["t-m2"]);
  });
});

describe("runPoll — watermark", () => {
  it("advances the watermark on a clean run", async () => {
    feed([
      fm({ id: "m3", subject: "Interview invite", body: "Please share your availability for an interview." }),
    ]);
    await runPoll(spyAnalyzer(an({ category: "Invitation" })));
    expect(setLastChecked).toHaveBeenCalledTimes(1);
  });

  it("does NOT advance the watermark (or mark processed) when the analyzer fails", async () => {
    feed([
      fm({ id: "m4", subject: "Interview invite", body: "Please share your availability for an interview." }),
    ]);
    const result = await runPoll(spyAnalyzer(null)); // transient failure
    expect(result.failed).toBe(1);
    expect(setLastChecked).not.toHaveBeenCalled();
    expect(vi.mocked(markProcessedBatch).mock.calls[0][1]).toEqual([]); // not marked → retried
  });
});

describe("runPoll — rule-first pre-filter (free, no AI)", () => {
  it("classifies an acknowledgement by rules: no AI call, row source 'rule', no alert", async () => {
    feed([fm({ id: "m5", subject: "Application received", body: "Thank you for applying." })]);
    const analyzer = spyAnalyzer(an({}));

    const result = await runPoll(analyzer);

    expect(analyzer.analyze).not.toHaveBeenCalled();
    const rows = vi.mocked(appendRows).mock.calls[0][1];
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("rule");
    expect(rows[0].category).toBe("Applied");
    expect(vi.mocked(notifyDigest).mock.calls[0][1]).toEqual([]); // acks never alert
    expect(result.ruleClassified).toBe(1);
    expect(result.aiCalls).toBe(0);
  });

  it("classifies a rejection by rules without an AI call", async () => {
    feed([
      fm({ id: "m6", subject: "Update", body: "Unfortunately we are moving forward with other candidates." }),
    ]);
    const analyzer = spyAnalyzer(an({}));

    await runPoll(analyzer);

    expect(analyzer.analyze).not.toHaveBeenCalled();
    const rows = vi.mocked(appendRows).mock.calls[0][1];
    expect(rows[0].source).toBe("rule");
    expect(rows[0].category).toBe("Rejection");
  });

  it("skips broad-query noise for free: no AI, no row, but marked processed", async () => {
    feed([fm({ id: "m7", subject: "Newsletter", body: "Read our latest engineering blog post." })]);
    const analyzer = spyAnalyzer(an({}));

    const result = await runPoll(analyzer);

    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(vi.mocked(appendRows).mock.calls[0][1]).toEqual([]);
    expect(vi.mocked(markProcessedBatch).mock.calls[0][1]).toEqual(["t-m7"]);
    expect(result.irrelevant).toBe(1);
    expect(result.aiCalls).toBe(0);
  });
});

describe("runPoll — full routing in one pass", () => {
  it("routes self/ack/rejection/invitation/noise correctly, spending exactly one AI call", async () => {
    feed([
      fm({ id: "s", isSelfNotification: true, subject: "🚨 Job Agent: 1 update" }),
      fm({ id: "a", subject: "Application received", body: "Thank you for applying." }),
      fm({ id: "r", subject: "Update", body: "Unfortunately we are moving forward with other candidates." }),
      fm({
        id: "i",
        subject: "Interview invite",
        body: "We'd like to invite you to an interview. Please share your availability.",
        senderDomain: "acme.com",
      }),
      fm({ id: "n", subject: "Newsletter", body: "Read our latest engineering blog post." }),
    ]);
    const analyzer = spyAnalyzer(an({ company: "Acme", category: "Invitation", step: "HR screen" }));

    const result = await runPoll(analyzer);

    expect(analyzer.analyze).toHaveBeenCalledTimes(1); // only the invitation costs AI
    expect(result.ruleClassified).toBe(2); // ack + rejection
    expect(result.aiCalls).toBe(1);
    expect(result.skipped).toBe(1); // self-notification
    expect(result.irrelevant).toBe(1); // noise

    const rows = vi.mocked(appendRows).mock.calls[0][1];
    expect(rows.map((row) => `${row.category}:${row.source}`).sort()).toEqual([
      "Applied:rule",
      "Invitation:ai",
      "Rejection:rule",
    ]);
    expect(vi.mocked(notifyDigest).mock.calls[0][1]).toHaveLength(1); // only the invitation alerts
    expect(vi.mocked(markProcessedBatch).mock.calls[0][1]).toEqual(["t-s", "t-a", "t-r", "t-i", "t-n"]);
  });
});

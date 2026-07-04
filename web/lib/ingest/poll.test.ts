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
vi.mock("@/lib/google/gmail", () => ({ searchMessages: vi.fn(), fetchMessage: vi.fn() }));
vi.mock("@/lib/google/sheets", () => ({
  ensureSheets: vi.fn(),
  getLastChecked: vi.fn(),
  getProcessedIds: vi.fn(),
  markProcessedBatch: vi.fn(),
  appendRows: vi.fn(),
  appendRawEmails: vi.fn(),
  setLastChecked: vi.fn(),
}));
vi.mock("@/lib/notify", () => ({ notifyDigest: vi.fn() }));

import { runPoll } from "./poll";
import { searchMessages, fetchMessage } from "@/lib/google/gmail";
import {
  appendRawEmails,
  appendRows,
  getLastChecked,
  getProcessedIds,
  markProcessedBatch,
  setLastChecked,
} from "@/lib/google/sheets";
import { notifyDigest } from "@/lib/notify";

// Watermark used by all tests (epoch seconds). Messages default to a date far
// after it; legacy-suppression tests use PRE_WATERMARK_ISO (before it).
const WATERMARK = 1_750_000_000; // 2025-06-15T14:26:40Z
const PRE_WATERMARK_ISO = "2025-06-01T00:00:00.000Z";

/** Minimal FetchedMessage builder (threadId defaults to `t-<id>`). */
function fm(partial: Partial<FetchedMessage>): FetchedMessage {
  const id = partial.id ?? "m";
  return {
    id,
    threadId: `t-${id}`,
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

/** Wires searchMessages → the given messages and fetchMessage → lookup by id. */
function feed(messages: FetchedMessage[]): void {
  vi.mocked(searchMessages).mockResolvedValue(
    messages.map((m) => ({ messageId: m.id, threadId: m.threadId })),
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
  vi.mocked(getProcessedIds).mockResolvedValue({
    messageIds: new Set(),
    legacyThreadIds: new Set(),
  });
  vi.mocked(getLastChecked).mockResolvedValue(WATERMARK);
  vi.mocked(searchMessages).mockResolvedValue([]);
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
    expect(vi.mocked(markProcessedBatch).mock.calls[0][1]).toEqual([
      { messageId: "m1", threadId: "t-m1" },
    ]); // still marked
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
    expect(rows[0].messageId).toBe("m2");
    const alerts = vi.mocked(notifyDigest).mock.calls[0][1];
    expect(alerts).toHaveLength(1);
    expect(result.invitations).toBe(1);
    expect(vi.mocked(markProcessedBatch).mock.calls[0][1]).toEqual([
      { messageId: "m2", threadId: "t-m2" },
    ]);
  });
});

describe("runPoll — per-message dedup (the missed-reply bug)", () => {
  it("analyzes a NEW reply in a thread whose earlier message was already processed", async () => {
    // Same thread "t-conv": "old" was processed on a previous run; "reply" is new.
    feed([
      fm({
        id: "reply",
        threadId: "t-conv",
        subject: "Re: Your application",
        body: "We'd like to invite you to an interview. Please share your availability.",
      }),
    ]);
    vi.mocked(getProcessedIds).mockResolvedValue({
      messageIds: new Set(["old"]),
      legacyThreadIds: new Set(),
    });
    const analyzer = spyAnalyzer(an({ category: "Invitation", step: "HR screen" }));

    const result = await runPoll(analyzer);

    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    const rows = vi.mocked(appendRows).mock.calls[0][1];
    expect(rows).toHaveLength(1);
    expect(rows[0].threadId).toBe("t-conv");
    expect(rows[0].messageId).toBe("reply");
    expect(result.invitations).toBe(1);
  });

  it("skips a message that was itself already processed", async () => {
    feed([fm({ id: "seen", subject: "Interview invite", body: "Please share your availability." })]);
    vi.mocked(getProcessedIds).mockResolvedValue({
      messageIds: new Set(["seen"]),
      legacyThreadIds: new Set(),
    });
    const analyzer = spyAnalyzer(an({}));

    const result = await runPoll(analyzer);

    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(fetchMessage).not.toHaveBeenCalled(); // cheap skip, no fetch
    expect(result.skipped).toBe(1);
  });
});

describe("runPoll — raw email cache", () => {
  it("caches classified messages (rule + ai) but not noise", async () => {
    feed([
      fm({ id: "a", subject: "Application received", body: "Thank you for applying." }),
      fm({
        id: "i",
        subject: "Interview invite",
        body: "We'd like to invite you to an interview. Please share your availability.",
      }),
      fm({ id: "n", subject: "Newsletter", body: "Read our latest engineering blog post." }),
    ]);

    await runPoll(spyAnalyzer(an({ category: "Invitation" })));

    const cached = vi.mocked(appendRawEmails).mock.calls[0][1];
    expect(cached.map((r) => r.messageId).sort()).toEqual(["a", "i"]);
    expect(cached[0].body).toBeTruthy();
  });
});

describe("runPoll — offer guard (the false-Offer bug)", () => {
  it("downgrades a model 'Offer' that schedules an interview with no compensation language", async () => {
    feed([
      fm({
        id: "m-slot",
        subject: "Next steps at AppsFlyer",
        body: "We'd like to offer you an interview slot on Monday, July 6 at 12:00.",
      }),
    ]);
    // The model misreads "offer you an interview slot" as a job offer.
    const analyzer = spyAnalyzer(
      an({ category: "Offer", step: "Offer", interview_datetime: "2026-07-06T12:00:00" }),
    );

    const result = await runPoll(analyzer);

    const rows = vi.mocked(appendRows).mock.calls[0][1];
    expect(rows[0].category).toBe("Invitation");
    expect(rows[0].step).toBe("Interview");
    const alerts = vi.mocked(notifyDigest).mock.calls[0][1];
    expect(alerts[0].category).toBe("Invitation");
    expect(result.invitations).toBe(1);
    expect(result.offers).toBe(0);
  });

  it("keeps a real offer (compensation language present)", async () => {
    feed([
      fm({
        id: "m-real",
        subject: "Your offer letter",
        body: "Attached is your offer letter — base salary, equity and start date inside. Call Monday 10:00 to review.",
      }),
    ]);
    const analyzer = spyAnalyzer(
      an({ category: "Offer", step: "Offer", interview_datetime: "2026-07-06T10:00:00" }),
    );

    const result = await runPoll(analyzer);

    const rows = vi.mocked(appendRows).mock.calls[0][1];
    expect(rows[0].category).toBe("Offer");
    expect(result.offers).toBe(1);
  });
});

describe("runPoll — legacy (v1 per-thread) marker compatibility", () => {
  it("suppresses pre-watermark mail in a legacy thread without marking it processed", async () => {
    // The legacy marker means "this thread was settled up to the watermark";
    // backfill (not the poller) owns anything older that was silently missed.
    feed([
      fm({
        id: "old-reply",
        threadId: "t-legacy",
        date: PRE_WATERMARK_ISO,
        subject: "Interview invite",
        body: "Please share your availability for an interview.",
      }),
    ]);
    vi.mocked(getProcessedIds).mockResolvedValue({
      messageIds: new Set(["t-legacy"]),
      legacyThreadIds: new Set(["t-legacy"]),
    });
    const analyzer = spyAnalyzer(an({}));

    const result = await runPoll(analyzer);

    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(vi.mocked(appendRows).mock.calls[0][1]).toEqual([]);
    expect(vi.mocked(markProcessedBatch).mock.calls[0][1]).toEqual([]); // left for backfill
    expect(result.skipped).toBe(1);
  });

  it("analyzes a post-watermark reply in a legacy thread", async () => {
    feed([
      fm({
        id: "new-reply",
        threadId: "t-legacy",
        subject: "Re: Your application",
        body: "We'd like to invite you to an interview. Please share your availability.",
      }),
    ]);
    vi.mocked(getProcessedIds).mockResolvedValue({
      messageIds: new Set(["t-legacy"]),
      legacyThreadIds: new Set(["t-legacy"]),
    });
    const analyzer = spyAnalyzer(an({ category: "Invitation", step: "HR screen" }));

    const result = await runPoll(analyzer);

    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    const rows = vi.mocked(appendRows).mock.calls[0][1];
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe("new-reply");
    expect(result.invitations).toBe(1);
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
    expect(vi.mocked(markProcessedBatch).mock.calls[0][1]).toEqual([
      { messageId: "m7", threadId: "t-m7" },
    ]);
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
    expect(vi.mocked(markProcessedBatch).mock.calls[0][1]).toEqual([
      { messageId: "s", threadId: "t-s" },
      { messageId: "a", threadId: "t-a" },
      { messageId: "r", threadId: "t-r" },
      { messageId: "i", threadId: "t-i" },
      { messageId: "n", threadId: "t-n" },
    ]);
  });
});

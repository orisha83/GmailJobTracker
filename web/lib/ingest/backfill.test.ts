import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FetchedMessage } from "@/lib/google/gmail";
import type { Analysis, EmailAnalyzer } from "@/lib/ai/analyzer";
import type { TrackedJob } from "@/lib/google/sheets";

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
  readRows: vi.fn(),
  getProcessedIds: vi.fn(),
  appendRows: vi.fn(),
  appendRawEmails: vi.fn(),
  batchUpdateValues: vi.fn(),
  markProcessedBatch: vi.fn(),
}));

import { runBackfill } from "./backfill";
import { fetchMessage, listThreadMessageIds } from "@/lib/google/gmail";
import {
  appendRows,
  batchUpdateValues,
  getProcessedIds,
  markProcessedBatch,
  readRows,
} from "@/lib/google/sheets";

function fm(partial: Partial<FetchedMessage>): FetchedMessage {
  const id = partial.id ?? "m";
  return {
    id,
    threadId: `t-${id}`,
    subject: "",
    body: "",
    date: "2026-06-25T09:00:00.000Z",
    senderName: "",
    senderDomain: "",
    links: [],
    isSelfNotification: false,
    ...partial,
  };
}

function row(partial: Partial<TrackedJob>): TrackedJob {
  const step = partial.step ?? "Applied";
  return {
    rowNumber: 2,
    received: "2026-06-20T09:00:00.000Z",
    company: "Kela",
    companyKey: "kela",
    role: "Product Manager - Threat Intelligence",
    category: "Applied",
    interviewDateTime: "",
    summary: "",
    source: "rule",
    threadId: "t-kela",
    link: "",
    interviewer: "",
    messageId: "",
    ...partial,
    step,
    status: partial.status ?? step,
  };
}

const invitation: Analysis = {
  is_relevant: true,
  company: "Kela",
  role: "Product Manager - Threat Intelligence",
  category: "Invitation",
  step: "HR screen",
  interview_datetime: "2026-07-02T12:00:00",
  summary: "",
  apply_url: "",
  interviewer_name: "",
};

function spyAnalyzer(result: Analysis | null): EmailAnalyzer & { analyze: ReturnType<typeof vi.fn> } {
  return { analyze: vi.fn().mockResolvedValue(result) };
}

/** Wires thread listings + message fetches. */
function feedThreads(
  threads: Record<string, FetchedMessage[]>,
): void {
  vi.mocked(listThreadMessageIds).mockImplementation(async (_auth, threadId) =>
    (threads[threadId] ?? []).map((m) => ({ messageId: m.id, internalDate: m.date })),
  );
  const byId = new Map(Object.values(threads).flat().map((m) => [m.id, m]));
  vi.mocked(fetchMessage).mockImplementation(async (_auth, id) => byId.get(id) ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readRows).mockResolvedValue([]);
  vi.mocked(getProcessedIds).mockResolvedValue({
    messageIds: new Set(),
    legacyThreadIds: new Set(),
  });
  vi.mocked(listThreadMessageIds).mockResolvedValue([]);
  vi.mocked(fetchMessage).mockResolvedValue(null);
});

describe("runBackfill — the Kela repair", () => {
  it("migrates the known ack row and recovers the never-analyzed interview reply", async () => {
    // Thread t-kela: the ack was analyzed under the old scheme (legacy marker =
    // first message id = threadId is NOT how this thread was keyed — the row
    // exists but has no messageId). The invite reply was never analyzed.
    vi.mocked(readRows).mockResolvedValue([row({ rowNumber: 5 })]);
    vi.mocked(getProcessedIds).mockResolvedValue({
      messageIds: new Set(["t-kela"]),
      legacyThreadIds: new Set(["t-kela"]),
    });
    feedThreads({
      "t-kela": [
        fm({ id: "t-kela", threadId: "t-kela", date: "2026-06-19T08:00:00.000Z" }), // first msg, already processed
        fm({ id: "ack", threadId: "t-kela", date: "2026-06-20T09:00:00.000Z", subject: "Application received" }),
        fm({
          id: "invite",
          threadId: "t-kela",
          date: "2026-06-28T10:00:00.000Z",
          subject: "Interview — Kela",
          body: "We'd like to invite you to an interview on July 2 at 12:00. Please confirm.",
        }),
      ],
    });
    const analyzer = spyAnalyzer(invitation);

    const report = await runBackfill({}, analyzer);

    // "ack" matches the existing row by received time → migration, no AI.
    expect(report.migrated).toBe(1);
    expect(vi.mocked(batchUpdateValues).mock.calls[0][1]).toEqual([
      { range: "Tracker!N5", values: [["ack"]] },
    ]);
    // "invite" was never seen → analyzed and appended as a new row.
    expect(report.appended).toBe(1);
    const appended = vi.mocked(appendRows).mock.calls[0][1];
    expect(appended).toHaveLength(1);
    expect(appended[0].category).toBe("Invitation");
    expect(appended[0].messageId).toBe("invite");
    expect(appended[0].interviewDateTime).toBe("2026-07-02T12:00:00");
    // Both are now marked processed (per message).
    expect(vi.mocked(markProcessedBatch).mock.calls[0][1]).toEqual([
      { messageId: "ack", threadId: "t-kela" },
      { messageId: "invite", threadId: "t-kela" },
    ]);
    expect(report.done).toBe(true);
  });

  it("skips messages that are already processed", async () => {
    vi.mocked(readRows).mockResolvedValue([row({ messageId: "ack" })]);
    vi.mocked(getProcessedIds).mockResolvedValue({
      messageIds: new Set(["t-kela", "ack", "invite"]),
      legacyThreadIds: new Set(),
    });
    feedThreads({
      "t-kela": [
        fm({ id: "t-kela", threadId: "t-kela" }),
        fm({ id: "ack", threadId: "t-kela" }),
        fm({ id: "invite", threadId: "t-kela" }),
      ],
    });
    const analyzer = spyAnalyzer(invitation);

    const report = await runBackfill({}, analyzer);

    expect(report.messagesSeen).toBe(0);
    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(vi.mocked(appendRows).mock.calls[0][1]).toEqual([]);
  });
});

describe("runBackfill — safety", () => {
  it("marks self-notifications processed without analyzing them", async () => {
    vi.mocked(getProcessedIds).mockResolvedValue({
      messageIds: new Set(),
      legacyThreadIds: new Set(["t-self"]),
    });
    feedThreads({
      "t-self": [fm({ id: "digest", threadId: "t-self", isSelfNotification: true })],
    });
    const analyzer = spyAnalyzer(invitation);

    const report = await runBackfill({}, analyzer);

    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(report.appended).toBe(0);
    expect(vi.mocked(markProcessedBatch).mock.calls[0][1]).toEqual([
      { messageId: "digest", threadId: "t-self" },
    ]);
  });

  it("settles noise messages without AI and marks them processed", async () => {
    vi.mocked(getProcessedIds).mockResolvedValue({
      messageIds: new Set(),
      legacyThreadIds: new Set(["t-n"]),
    });
    feedThreads({
      "t-n": [fm({ id: "n1", threadId: "t-n", subject: "Newsletter", body: "Latest blog post." })],
    });
    const analyzer = spyAnalyzer(invitation);

    const report = await runBackfill({}, analyzer);

    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(report.noise).toBe(1);
    expect(vi.mocked(appendRows).mock.calls[0][1]).toEqual([]);
  });
});

describe("runBackfill — resumability", () => {
  it("stops at the AI budget and resumes from the same thread", async () => {
    vi.mocked(getProcessedIds).mockResolvedValue({
      messageIds: new Set(),
      legacyThreadIds: new Set(["t-a", "t-b"]),
    });
    const inviteBody = "We'd like to invite you to an interview. Please share your availability.";
    feedThreads({
      "t-a": [fm({ id: "a1", threadId: "t-a", subject: "Interview", body: inviteBody })],
      "t-b": [fm({ id: "b1", threadId: "t-b", subject: "Interview", body: inviteBody })],
    });
    const analyzer = spyAnalyzer(invitation);

    const first = await runBackfill({ limit: 1 }, analyzer);

    expect(first.aiCalls).toBe(1);
    expect(first.done).toBe(false);
    expect(first.nextIndex).toBe(1); // threads sorted: t-a done, t-b pending
    expect(vi.mocked(appendRows).mock.calls[0][1]).toHaveLength(1);

    const second = await runBackfill({ limit: 1, startIndex: first.nextIndex }, analyzer);
    expect(second.done).toBe(true);
    expect(second.appended).toBe(1);
  });

  it("caps threads per invocation and reports where to continue", async () => {
    vi.mocked(getProcessedIds).mockResolvedValue({
      messageIds: new Set(),
      legacyThreadIds: new Set(["t-1", "t-2", "t-3"]),
    });
    feedThreads({ "t-1": [], "t-2": [], "t-3": [] });

    const report = await runBackfill({ maxThreads: 2 }, spyAnalyzer(invitation));

    expect(report.threadsScanned).toBe(2);
    expect(report.done).toBe(false);
    expect(report.nextIndex).toBe(2);
  });
});

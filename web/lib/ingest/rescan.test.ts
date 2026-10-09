import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FetchedMessage } from "@/lib/google/gmail";
import type { Analysis } from "@/lib/ai/analyzer";
import type { TrackedJob } from "@/lib/google/sheets";

vi.mock("@/lib/config", () => ({
  config: { ingest: { searchQuery: "Q", maxPerRun: 1, throttleMs: 0, candidateName: "" } },
}));
vi.mock("@/lib/ai", () => ({ getAnalyzer: () => ({ analyze: vi.fn() }) }));
vi.mock("@/lib/google/auth", () => ({ makeAuthedClient: () => ({}) }));
vi.mock("@/lib/google/gmail", () => ({ searchMessagesPage: vi.fn(), fetchMessage: vi.fn() }));
vi.mock("@/lib/google/sheets", () => ({
  ensureSheets: vi.fn(),
  readRows: vi.fn(),
  readRawEmails: vi.fn(async () => new Map()),
  appendRows: vi.fn(),
  appendRawEmails: vi.fn(),
  markProcessedBatch: vi.fn(),
}));

import { runRescan } from "./rescan";
import { fetchMessage, searchMessagesPage } from "@/lib/google/gmail";
import { appendRows, markProcessedBatch, readRawEmails, readRows } from "@/lib/google/sheets";

function fm(partial: Partial<FetchedMessage>): FetchedMessage {
  const id = partial.id ?? "m";
  return {
    id,
    threadId: `t-${id}`,
    subject: "",
    body: "",
    date: "2026-07-13T09:00:00.000Z",
    senderName: "",
    senderDomain: "",
    links: [],
    isSelfNotification: false,
    ...partial,
  };
}

function feed(messages: FetchedMessage[]): void {
  vi.mocked(searchMessagesPage).mockResolvedValue({
    hits: messages.map((m) => ({ messageId: m.id, threadId: m.threadId })),
  });
  const byId = new Map(messages.map((m) => [m.id, m]));
  vi.mocked(fetchMessage).mockImplementation(async (_a, id) => byId.get(id) ?? null);
}

const playtika = fm({
  id: "p1",
  subject: "Update on Your Application to Playtika",
  body: "After thoughtful consideration, we won’t be continuing the recruitment process with you.",
  senderName: "no-reply@playtika.com",
  senderDomain: "playtika.com",
});
const needsAi = fm({ id: "a1", subject: "Next steps", body: "Can we schedule an interview?", senderDomain: "acme.com" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readRows).mockResolvedValue([]);
});

describe("runRescan", () => {
  it("dry run: reports rule-settled recoveries, lists AI candidates, writes and spends nothing", async () => {
    feed([playtika, needsAi]);
    const analyze = vi.fn();
    const r = await runRescan({ since: "2026-06-01" }, { analyze });
    expect(r.added).toEqual([expect.objectContaining({ company: "Playtika", category: "Rejection", source: "rule" })]);
    expect(r.needsAi.map((n) => n.subject)).toEqual(["Next steps"]);
    expect(analyze).not.toHaveBeenCalled();
    expect(appendRows).not.toHaveBeenCalled();
    expect(markProcessedBatch).not.toHaveBeenCalled();
  });

  it("never re-adds mail that already has a row (by messageId or legacy thread+day)", async () => {
    vi.mocked(readRows).mockResolvedValue([
      { messageId: "p1", threadId: "t-p1", received: "2026-07-13T09:00:00.000Z", company: "Playtika", companyKey: "playtika" },
      { messageId: "", threadId: "t-x", received: "2026-07-13T09:00:00.000Z", company: "X", companyKey: "x" },
    ] as TrackedJob[]);
    feed([playtika, fm({ id: "x", threadId: "t-x", subject: "Unfortunately", body: "unfortunately" })]);
    const r = await runRescan({ since: "2026-06-01" }, { analyze: vi.fn() });
    expect(r.added).toEqual([]);
    expect(r.alreadyTracked).toBe(2);
  });

  it("apply: appends recovered rows (snapped to known companies) and marks them processed", async () => {
    vi.mocked(readRows).mockResolvedValue([
      { messageId: "z", threadId: "t-z", received: "2026-07-01T00:00:00.000Z", company: "Playtika", companyKey: "playtika" },
    ] as TrackedJob[]);
    feed([playtika]);
    await runRescan({ since: "2026-06-01", dryRun: false }, { analyze: vi.fn() });
    expect(vi.mocked(appendRows).mock.calls[0][1]).toEqual([
      expect.objectContaining({ messageId: "p1", company: "Playtika", category: "Rejection", status: "Rejected" }),
    ]);
    expect(vi.mocked(markProcessedBatch).mock.calls[0][1]).toEqual([{ messageId: "p1", threadId: "t-p1" }]);
  });

  it("apply: stops at the AI budget and returns a cursor at the unprocessed message", async () => {
    const second = fm({ id: "a2", subject: "Interview", body: "Can we schedule an interview?" });
    feed([needsAi, second]);
    const result: Analysis = {
      is_relevant: true, company: "Acme", role: "PM", category: "Invitation", step: "HR screen",
      interview_datetime: null, summary: "", apply_url: "", interviewer_name: "",
    };
    const analyze = vi.fn().mockResolvedValue(result);
    const r = await runRescan({ since: "2026-06-01", dryRun: false }, { analyze });
    expect(analyze).toHaveBeenCalledTimes(1); // maxPerRun = 1
    expect(r.done).toBe(false);
    expect(r.cursor).toBe("|1");
  });

  it("keeps one copy of an ack re-sent several times the same day", async () => {
    const ack = (id: string) =>
      fm({ id, subject: "Thank you for applying to Acme", body: "We received your application.", senderName: "Acme", senderDomain: "acme.com" });
    feed([ack("c1"), ack("c2"), ack("c3")]);
    const r = await runRescan({ since: "2026-06-01" }, { analyze: vi.fn() });
    expect(r.added).toHaveLength(1);
    expect(r.duplicates).toBe(2);
  });

  it("never adds a re-sent copy of mail an earlier run already recovered", async () => {
    vi.mocked(readRows).mockResolvedValue([
      { messageId: "c1", threadId: "t-c1", received: "2026-07-13T09:00:00.000Z", company: "Acme", companyKey: "acme", category: "Applied" },
    ] as TrackedJob[]);
    vi.mocked(readRawEmails).mockResolvedValue(
      new Map([["c1", { subject: "Thank you for applying to Acme" } as never]]),
    );
    feed([fm({ id: "c2", subject: "Thank you for applying to Acme", body: "We received your application.", senderName: "Acme", senderDomain: "acme.com" })]);
    const r = await runRescan({ since: "2026-06-01" }, { analyze: vi.fn() });
    expect(r.added).toEqual([]);
    expect(r.duplicates).toBe(1);
  });

  it("rejects a malformed date", async () => {
    await expect(runRescan({ since: "June" }, { analyze: vi.fn() })).rejects.toThrow(/Invalid date/);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FetchedMessage } from "@/lib/google/gmail";
import type { TrackedJob } from "@/lib/google/sheets";

vi.mock("@/lib/google/gmail", () => ({ searchMessages: vi.fn(), fetchMessage: vi.fn() }));

import { collectSentSubmissions } from "./sent";
import { fetchMessage, searchMessages } from "@/lib/google/gmail";

function fm(partial: Partial<FetchedMessage>): FetchedMessage {
  const id = partial.id ?? "s";
  return {
    id,
    threadId: `t-${id}`,
    subject: "",
    body: "",
    date: "2026-10-06T10:00:00.000Z",
    senderName: "Ori Shalom",
    senderDomain: "gmail.com",
    links: [],
    to: [],
    isSelfNotification: false,
    ...partial,
  };
}
function feed(messages: FetchedMessage[]): void {
  vi.mocked(searchMessages).mockResolvedValue(messages.map((m) => ({ messageId: m.id, threadId: m.threadId })));
  const byId = new Map(messages.map((m) => [m.id, m]));
  vi.mocked(fetchMessage).mockImplementation(async (_a, id) => byId.get(id) ?? null);
}
const row = (p: Partial<TrackedJob>) =>
  ({ rowNumber: 2, received: "2026-10-01T00:00:00.000Z", company: "mPrest", companyKey: "mprest", role: "Product Maker",
     step: "Home assignment", category: "Invitation", status: "Home assignment", source: "ai", threadId: "t-hen",
     messageId: "m-hen", interviewDateTime: "", summary: "", link: "", interviewer: "", ...p }) as TrackedJob;

const SUBMIT = "Hi Hen, I'm pleased to submit my completed home assignment.";
const opts = (rows: TrackedJob[], senderDomains = new Map<string, string>()) => ({
  timeBound: "after:1", rows, senderDomains, processedIds: new Set<string>(),
});

beforeEach(() => vi.clearAllMocks());

describe("collectSentSubmissions", () => {
  it("logs a submission in a tracked thread on that application (Progress, source sent)", async () => {
    feed([fm({ id: "s1", threadId: "t-hen", subject: "Re: Home Assignment", body: SUBMIT })]);
    const scan = await collectSentSubmissions({} as never, opts([row({})]));
    expect(scan.rows).toEqual([
      expect.objectContaining({
        company: "mPrest", companyKey: "mprest", role: "Product Maker", category: "Progress",
        step: "Assignment submitted", source: "sent", received: "2026-10-06T10:00:00.000Z", messageId: "s1",
      }),
    ]);
    expect(scan.processed).toEqual([{ messageId: "s1", threadId: "t-hen" }]);
    expect(vi.mocked(searchMessages).mock.calls[0][1]).toBe("in:sent after:1 -to:me");
  });

  it("matches a new thread by the company's own domain (not an ATS relay)", async () => {
    feed([fm({ id: "s2", threadId: "t-new", to: ["igali@comm-it.com"], body: "מצ״ב לינק לפתרון המטלה" })]);
    const rows = [row({ company: "Comm-IT", companyKey: "commit", threadId: "t-x", messageId: "m-x" })];
    const scan = await collectSentSubmissions({} as never, opts(rows, new Map([["m-x", "mail.comm-it.com"]])));
    expect(scan.rows[0]).toMatchObject({ company: "Comm-IT", threadId: "t-new" });
  });

  it("never matches through an ATS relay domain", async () => {
    feed([fm({ id: "s3", threadId: "t-new", to: ["x@us.greenhouse-mail.io"], body: SUBMIT })]);
    const rows = [row({ threadId: "t-x", messageId: "m-x" })];
    const scan = await collectSentSubmissions({} as never, opts(rows, new Map([["m-x", "us.greenhouse-mail.io"]])));
    expect(scan.rows).toEqual([]);
    expect(scan.processed).toEqual([]); // left for a later rescan
  });

  it("a scheduling reply is settled (processed) but not logged", async () => {
    feed([fm({ id: "s4", threadId: "t-hen", body: "Yes, 12:00 is great." })]);
    const scan = await collectSentSubmissions({} as never, opts([row({})]));
    expect(scan.rows).toEqual([]);
    expect(scan.processed).toHaveLength(1);
  });

  it("skips our own digests and already-processed mail", async () => {
    feed([
      fm({ id: "s5", threadId: "t-hen", body: SUBMIT, isSelfNotification: true }),
      fm({ id: "s6", threadId: "t-hen", body: SUBMIT }),
    ]);
    const o = opts([row({})]);
    o.processedIds.add("s6");
    const scan = await collectSentSubmissions({} as never, o);
    expect(scan.rows).toEqual([]);
    expect(fetchMessage).toHaveBeenCalledTimes(1); // s6 never fetched
  });
});

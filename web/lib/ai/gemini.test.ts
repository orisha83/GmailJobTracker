import { describe, it, expect, vi, afterEach } from "vitest";
import { GeminiAnalyzer } from "./gemini";
import type { EmailInput } from "./analyzer";

const INPUT: EmailInput = {
  subject: "Scheduling your Phone interview with Trigo",
  body: "Please book a slot for your phone interview.",
  emailDate: "2026-07-08T12:27:57.000Z",
};

const VALID_BODY = JSON.stringify({
  candidates: [
    {
      content: {
        parts: [
          {
            text: JSON.stringify({
              is_relevant: true,
              company: "Trigo",
              role: "Product Manager",
              category: "Invitation",
              step: "Phone interview",
              interview_datetime: null,
              summary: "Book a phone interview slot.",
              apply_url: "",
              interviewer_name: "",
            }),
          },
        ],
      },
    },
  ],
});

function analyzer() {
  return new GeminiAnalyzer("test-key", "model-a", "Asia/Jerusalem", "model-b");
}

afterEach(() => vi.unstubAllGlobals());

describe("GeminiAnalyzer — model fallback on overload", () => {
  it("falls back to the secondary model on 503 (the stalled-Trigo bug)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("overloaded", { status: 503 }))
      .mockResolvedValueOnce(new Response(VALID_BODY, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const a = await analyzer().analyze(INPUT);

    expect(a?.category).toBe("Invitation");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("/models/model-a:");
    expect(fetchMock.mock.calls[1][0]).toContain("/models/model-b:");
  });

  it("falls back on 429 (per-model quota)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("quota", { status: 429 }))
      .mockResolvedValueOnce(new Response(VALID_BODY, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const a = await analyzer().analyze(INPUT);

    expect(a?.company).toBe("Trigo");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses one call when the primary model succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(VALID_BODY, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const a = await analyzer().analyze(INPUT);

    expect(a?.step).toBe("Phone interview");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on non-retryable errors (400)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const a = await analyzer().analyze(INPUT);

    expect(a).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null (→ retried next run) when both models are down", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("overloaded", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const a = await analyzer().analyze(INPUT);

    expect(a).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never hops when the fallback equals the primary (disabled)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("overloaded", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const a = await new GeminiAnalyzer("test-key", "model-a", "Asia/Jerusalem", "model-a").analyze(INPUT);

    expect(a).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

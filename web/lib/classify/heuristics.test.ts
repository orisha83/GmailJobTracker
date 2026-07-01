import { describe, it, expect } from "vitest";
import type { FetchedMessage } from "@/lib/google/gmail";
import { classifyHeuristically, looksLikeInvitation } from "./heuristics";

/** Minimal FetchedMessage builder — override only what a test cares about. */
function msg(partial: Partial<FetchedMessage>): FetchedMessage {
  return {
    id: "m1",
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

describe("classifyHeuristically", () => {
  it("classifies an English rejection as Rejection/Rejected without AI", () => {
    const a = classifyHeuristically(
      msg({ subject: "Update on your application", body: "Unfortunately, we won't be moving forward." }),
    );
    expect(a?.category).toBe("Rejection");
    expect(a?.step).toBe("Rejected");
    expect(a?.is_relevant).toBe(true);
  });

  it("classifies a Hebrew rejection as Rejection", () => {
    const a = classifyHeuristically(msg({ subject: "עדכון", body: "לצערנו לא נמשיך עם מועמדותך." }));
    expect(a?.category).toBe("Rejection");
  });

  it("classifies an English acknowledgement as Applied/Applied", () => {
    const a = classifyHeuristically(
      msg({ subject: "We received your application", body: "Thank you for applying to the role." }),
    );
    expect(a?.category).toBe("Applied");
    expect(a?.step).toBe("Applied");
  });

  it("classifies a Hebrew acknowledgement as Applied", () => {
    const a = classifyHeuristically(msg({ subject: "אישור", body: "תודה על הגשת המועמדות שלך." }));
    expect(a?.category).toBe("Applied");
  });

  it("defers an ack that also contains a real invitation (mixed) to the AI", () => {
    const a = classifyHeuristically(
      msg({
        subject: "Thanks for applying",
        body: "Thank you for applying. We'd like to schedule a call — what times work?",
      }),
    );
    expect(a).toBeNull();
  });

  it("defers a pure invitation (no ack/rejection) to the AI", () => {
    const a = classifyHeuristically(
      msg({ subject: "Next steps", body: "Please schedule a 30-minute interview this week." }),
    );
    expect(a).toBeNull();
  });

  it("extracts the company name from a non-generic sender", () => {
    const a = classifyHeuristically(
      msg({ senderName: "Acme Careers", body: "Unfortunately we are moving forward with other candidates." }),
    );
    expect(a?.company).toBe("Acme");
  });
});

describe("looksLikeInvitation", () => {
  it("is true for interview/recruiter signal", () => {
    expect(
      looksLikeInvitation(msg({ subject: "Interview invite", body: "Let's set up a call with the hiring manager." })),
    ).toBe(true);
  });

  it("is false for broad-query newsletter noise", () => {
    expect(
      looksLikeInvitation(msg({ subject: "Weekly product digest", body: "Read about our latest release notes." })),
    ).toBe(false);
  });

  it("is true for an offer email (so offers aren't skipped as noise)", () => {
    expect(
      looksLikeInvitation(msg({ subject: "Your offer", body: "We are pleased to extend an offer for the role." })),
    ).toBe(true);
  });
});

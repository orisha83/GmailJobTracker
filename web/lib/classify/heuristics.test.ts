import { describe, it, expect } from "vitest";
import type { FetchedMessage } from "@/lib/google/gmail";
import { classifyHeuristically, looksLikeInvitation } from "./heuristics";

/** Minimal FetchedMessage builder — override only what a test cares about. */
function msg(partial: Partial<FetchedMessage>): FetchedMessage {
  return {
    id: "m1",
    threadId: "t-m1",
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

describe("company extraction — recruiter/person senders and odd subjects", () => {
  it("prefers the subject's company over a recruiter's personal sender name", () => {
    const a = classifyHeuristically(
      msg({
        senderName: "Channi Refaelovich",
        senderDomain: "residenthome.com",
        subject: "Thank you for applying to Ashley Digital.",
        body: "Thank you for applying. Unfortunately we won't be moving forward.",
      }),
    );
    expect(a?.company).toBe("Ashley Digital");
  });

  it("reads 'position at X' subjects sent by a person", () => {
    const a = classifyHeuristically(
      msg({
        senderName: "Dinor Shahaf",
        senderDomain: "careers.gambit.security",
        subject: "Thank you for applying for the Senior Product Manager position at Gambit Security",
        body: "Unfortunately we decided to proceed with other candidates.",
      }),
    );
    expect(a?.company).toBe("Gambit Security");
  });

  it("never mistakes 'applying to the X role' for a company (falls back to domain)", () => {
    const a = classifyHeuristically(
      msg({
        senderName: "no-reply@aidoc.com",
        senderDomain: "aidoc.com",
        subject: "Aidoc 👋 Thanks for applying to the Platform Product Manager role",
        body: "Thank you for applying. Our team is reviewing your application.",
      }),
    );
    expect(a?.company).toBe("Aidoc");
  });

  it("understands 'your application to X' subjects", () => {
    const a = classifyHeuristically(
      msg({
        senderName: "no-reply@eu.greenhouse-mail.io",
        senderDomain: "eu.greenhouse-mail.io",
        subject: "Important information about your application to Guidde",
        body: "We have decided to proceed with other candidates.",
      }),
    );
    expect(a?.company).toBe("Guidde");
  });

  it("uses the ATS 'on behalf of' line when the subject names no company", () => {
    const a = classifyHeuristically(
      msg({
        senderName: "Shani Moshe",
        senderDomain: "aquasec.comeet-notifications.com",
        subject: "An update on your application",
        body: "Sent by Spark Hire Recruit on behalf of Aqua Security. Unfortunately we will not be moving forward.",
      }),
    );
    expect(a?.company).toBe("Aqua Security");
  });

  it("strips a trailing emoji from subject-extracted companies and rejects gerund roles", () => {
    const a = classifyHeuristically(
      msg({
        senderName: "Tal Fisko - Ubeya",
        senderDomain: "ubeya.teamtailor-mail.com",
        subject: "Thank You for Applying to Ubeya 🏟️",
        body: "We have decided not to move forward with your application at this time.",
      }),
    );
    expect(a?.company).toBe("Ubeya");
    expect(a?.role).toBe("Unknown"); // not "Applying to Ubeya 🏟️"
  });
});

describe("rejections that open with ack language (the Aidoc miss)", () => {
  it("classifies 'decided not to continue with the process' as a Rejection", () => {
    const a = classifyHeuristically(
      msg({
        subject: "Aidoc | Thank you for your interest in the Platform Product Manager role",
        body: "Thank you for applying to the Platform Product Manager role at Aidoc. After reviewing your application, we've decided not to continue with the process at this stage. Wishing you all the best in your search.",
      }),
    );
    expect(a?.category).toBe("Rejection");
    expect(a?.step).toBe("Rejected");
  });

  it("defers an ack with a rejection-ish cue to the AI instead of shortcutting", () => {
    // Real QuantHealth ack: conditional-future language + "best of luck"
    // boilerplate. Not clearly a rejection → the AI must read it.
    const a = classifyHeuristically(
      msg({
        subject: "Thank you for applying to QuantHealth",
        body: "We received your application for the Senior Product Manager position. Our team will review your application and will contact you if your qualifications match. Thank you again and we wish you the best of luck!",
      }),
    );
    expect(a).toBeNull();
  });

  it("still shortcuts an ack without any rejection cue", () => {
    const a = classifyHeuristically(
      msg({
        subject: "Application received",
        body: "Thank you for applying. Our team is reviewing your application and will contact you about next steps.",
      }),
    );
    expect(a?.category).toBe("Applied");
  });
});

describe("invitation phrasing with an adjective round name", () => {
  it("defers an ack + 'invite you to a phone interview' to the AI (not rule-Applied)", () => {
    const a = classifyHeuristically(
      msg({
        subject: "KELA — next steps",
        body: "Thank you for applying to KELA. We'd like to invite you to a phone interview next week.",
      }),
    );
    expect(a).toBeNull(); // mixed ack + invitation → AI decides
  });

  it("still shortcuts a pure ack", () => {
    const a = classifyHeuristically(
      msg({ subject: "Application received", body: "Thank you for applying. We will review your CV." }),
    );
    expect(a?.category).toBe("Applied");
  });
});

import { describe, it, expect } from "vitest";
import { classifySent, ownText } from "./sent";

const sent = (body: string, subject = "Re: Home Assignment") => classifySent({ subject, body });

describe("classifySent — your real submissions", () => {
  it.each([
    ["mPrest", "Hi Hen, I'm pleased to submit my completed home assignment for the Product Maker role, including the PRD."],
    ["Kela", "Hi Yael, Attached is the link to my deck. Inside it is a link to the mockup. Looking forward to hearing from you."],
    ["Comm-IT (Hebrew)", "היי גל, מצ״ב לינק לפתרון המטלה. תודה רבה, אורי"],
    ["curly apostrophe", "Hi, here’s my solution for the take-home exercise."],
    ["assignment first", "The completed assignment is attached. Thanks!"],
    ["hard-wrapped plain text with a URL line (real Comm-IT)", "היי גל,\r\nמצ״ב לינק\r\n<https://claude.ai/code/artifact/x>\r\nלפתרון המטלה.\r\n\r\nתודה רבה,\r\nאורי"],
  ])("%s → Assignment submitted", (_name, body) => {
    expect(sent(body)?.step).toBe("Assignment submitted");
  });
});

describe("classifySent — not submissions", () => {
  it.each([
    ["availability", "Hi Yael, Yes, 12:00 is great. Thank you, Ori"],
    ["Hebrew availability", "היי נועה, כן אני בח״ול. מבחינתי אפשרי ב 5,6,8 באוקטובר."],
    ["nudge (past tense)", "Hi Igal, I sent my solution to the home assignment to Gal on Monday, and I haven't received a response."],
    ["Hebrew nudge", "היי גל, לא קיבלתי ממך תגובה אם קיבלת את הפתרון שלי למטלה."],
    ["CV attached", "היי שלומית, אשמח שנשוחח, מצ״ב קורות החיים שלי."],
    ["before starting (wrapped)", "Just wanted to make sure we are still on track before i start the home\r\nassignment."],
    ["nudge with a link (real Comm-IT)", "I sent my solution to the home assignment to Gal on Monday, and I haven't\r\nreceived any confirmation. I assume she is on vacation. Please find it here\r\n<https://x.y/z> for\r\nyou as well"],
    ["clarifying question", "Hi Hen, I'd like to clarify which deliverables are expected for the initial submission."],
  ])("%s → null", (_name, body) => {
    expect(sent(body)).toBeNull();
  });

  it("ignores the company's wording in the quoted history", () => {
    const body =
      "Thanks, Tuesday works for me.\n\nOn Sun, 16 Aug 2026 at 19:44, Gal Kissous <gal@comm-it.com> wrote:\n> Attached is the home assignment, please submit by Sunday.";
    expect(sent(body)).toBeNull();
  });

  it("ignores Hebrew-quoted history too", () => {
    const body = "תודה, מתאים לי.\nבתאריך יום א׳, 16 באוג׳ 2026 ב-19:44 מאת גל <gal@comm-it.com>:\nמצ״ב המטלה, נא להגיש עד ראשון";
    expect(sent(body)).toBeNull();
  });
});

it("ownText cuts at the quote marker and flattens wrapping/URLs", () => {
  expect(ownText("Hello\nOn Mon, 1 Jan 2026 at 10:00, X <x@y.com> wrote:\nquoted")).toBe("Hello");
  expect(ownText("see\r\n<https://a.b/c>\r\nhere")).toBe("see link here");
});

import { describe, it, expect } from "vitest";
import { htmlToText, looksLikeHtml, toPlainText } from "./html";

describe("htmlToText", () => {
  it("drops head/style/comments and keeps the message text", () => {
    const html =
      "<!doctype html><html><head><style>body{margin:0}</style><title>x</title></head>" +
      "<body><!-- c --><p>Dear Ori,</p><p>We&rsquo;ve decided&nbsp;to move forward with candidates whose experience is a closer fit.</p></body></html>";
    const text = htmlToText(html);
    expect(text).not.toMatch(/margin|<|&/);
    expect(text).toContain("Dear Ori,");
    expect(text).toContain("We’ve decided to move forward with candidates");
  });

  it("decodes numeric entities (won&#39;t)", () => {
    expect(htmlToText("<p>we won&#39;t be moving forward</p>")).toBe("we won't be moving forward");
  });

  it("turns <br> and block ends into line breaks", () => {
    expect(htmlToText("a<br/>b<div>c</div>d")).toBe("a\nb c\nd");
  });
});

describe("toPlainText", () => {
  it("leaves plain text alone", () => {
    expect(toPlainText("Thanks <3 for applying")).toBe("Thanks <3 for applying");
    expect(looksLikeHtml("Thanks <3")).toBe(false);
  });
  it("converts HTML", () => {
    expect(toPlainText("<p>Hi</p>")).toBe("Hi");
  });
});

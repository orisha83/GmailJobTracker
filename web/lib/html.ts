/**
 * HTML email → readable text. Pure (no I/O) so ingestion, reprocess and tests
 * can all use it.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  zwnj: "",
  zwj: "",
};

export const looksLikeHtml = (s: string) =>
  /<(?:!doctype|html|head|body|style|meta|div|p|table|tr|td|span|br|h[1-6]|a|img)\b/i.test(s);

/**
 * Readable text from an HTML email: drops <head>/<style>/<script> and comments,
 * turns block ends into newlines, strips tags, decodes entities. Many ATS
 * emails (Comeet, Greenhouse, NVIDIA…) are HTML-only — without this the rules
 * and the model see a wall of CSS, and the AI's 3k-char window may hold no
 * message text at all.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(?:style|script)\b[\s\S]*$/i, " ") // unclosed (truncated) block
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t ​]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
}

/** Text for analysis from a decoded body: HTML is converted, plain text kept. */
export const toPlainText = (body: string) => (looksLikeHtml(body) ? htmlToText(body) : body);

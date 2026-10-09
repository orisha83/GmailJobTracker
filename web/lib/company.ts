/**
 * Company identity: one canonical key per employer, so an application, its
 * interviews and its rejection land on the SAME dashboard card even when the
 * emails name the company differently ("Armis" vs "Armis Security"), come from
 * a recruiter's personal name, or are relayed through an ATS domain.
 *
 * Pure functions — shared by ingestion, reprocess and the dashboard grouping.
 */

// Trailing words that describe the company type/department, not the employer.
// "Armis Security" ≡ "Armis", "DoiT International" ≡ "DoiT", "Glow Hiring Team"
// ≡ "Glow", "mprest.com" ≡ "mPrest". Only stripped while another word remains.
const SUFFIX_WORDS = new Set([
  "security",
  "technologies",
  "technology",
  "tech",
  "software",
  "inc",
  "ltd",
  "llc",
  "corp",
  "corporation",
  "limited",
  "international",
  "hiring",
  "recruiting",
  "recruitment",
  "careers",
  "career",
  "jobs",
  "team",
  "hr",
  "talent",
  "acquisition",
  "ai",
  "io",
  "com",
  "co",
  // Role words glued onto the company by bad extraction ("Stigg Product Manager").
  "product",
  "manager",
]);

/** Lower-case word tokens of a company name (Latin letters/digits only). */
function tokens(name: string): string[] {
  return (name || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// ATS / scheduling relays: the sender domain names the vendor, not the employer.
// The employer, when present, is the subdomain ("onestep.comeet-notifications.com").
const ATS_DOMAINS = [
  "greenhouse-mail.io",
  "greenhouse.io",
  "hire.lever.co",
  "lever.co",
  "myworkday.com",
  "workday.com",
  "ashbyhq.com",
  "comeet-notifications.com",
  "comeet.co",
  "comeet.com",
  "smartrecruiters.com",
  "workablemail.com",
  "workable.com",
  "bamboohr.com",
  "teamtailor-mail.com",
  "teamtailor.com",
  "breezy.hr",
  "jobvite.com",
  "icims.com",
  "taleo.net",
  "successfactors.com",
  "recruitee.com",
  "pinpointhq.com",
  "calendly.com",
];

// Mailbox providers: the domain says nothing about the employer.
const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "walla.co.il",
  "walla.com",
  "proton.me",
  "protonmail.com",
]);

// Domain labels that are infrastructure, never a company ("mail.amazon.jobs",
// "us.greenhouse-mail.io", "eu.greenhouse-mail.io").
const GENERIC_LABELS = new Set([
  "www",
  "mail",
  "email",
  "e",
  "em",
  "us",
  "eu",
  "uk",
  "app",
  "apps",
  "careers",
  "career",
  "jobs",
  "hire",
  "hiring",
  "recruiting",
  "talent",
  "notifications",
  "notification",
  "noreply",
  "no-reply",
  "info",
  "news",
  "mailer",
  "bounce",
]);

// Second-level public suffixes where the registrable name is one label further left.
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov"]);

const titleize = (s: string) =>
  s
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/**
 * The employer a sender domain points at, as a display name, or "" when the
 * domain can't tell (freemail, a bare ATS relay). ATS relays yield their
 * company subdomain; corporate domains their registrable name.
 */
export function domainCompanyName(domain: string): string {
  const d = (domain || "").toLowerCase().trim().replace(/^www\./, "");
  if (!d || FREEMAIL_DOMAINS.has(d)) return "";

  const ats = ATS_DOMAINS.find((a) => d === a || d.endsWith(`.${a}`));
  if (ats) {
    const sub = d.slice(0, Math.max(0, d.length - ats.length - 1));
    const labels = sub.split(".").filter((l) => l && !GENERIC_LABELS.has(l));
    return labels.length ? titleize(labels.join(" ")) : "";
  }

  const labels = d.split(".");
  labels.pop(); // TLD
  if (labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1])) labels.pop(); // co.il
  const name = [...labels].reverse().find((l) => !GENERIC_LABELS.has(l)) ?? "";
  return name ? titleize(name) : "";
}

// Mailbox names that never identify a company ("no-reply@us.greenhouse-mail.io").
const GENERIC_LOCAL_RE = /^(?:no-?reply|do-?not-?reply|noreply\w*|no-reply\w*|careers?|jobs?|hr|talent|recruit\w*|hiring|info|notifications?|mailer|apply)$/i;

/** A company name that is really an email address (an earlier extractor
 *  fallback): the domain's company, else — for ATS relays like Workday,
 *  "BitSight@myworkday.com" — the mailbox name. */
function emailCompanyKey(local: string, domain: string): string {
  const fromDomain = tokens(domainCompanyName(domain)).join("");
  if (fromDomain) return fromDomain;
  return GENERIC_LOCAL_RE.test(local) ? "" : tokens(local).join("");
}

/**
 * Canonical grouping key for a company: lower-case alphanumerics with
 * type/department suffixes stripped. Falls back to the sender domain's company
 * when the name is unknown/empty (or non-Latin), else "unknown".
 */
export function companyKeyFor(company: string, domain = ""): string {
  const email = (company || "").trim().match(/^([^\s@]+)@([a-z0-9.-]+\.[a-z]{2,})$/i);
  if (email) return emailCompanyKey(email[1], email[2]) || companyKeyFor("", domain);
  const t = tokens(company);
  while (t.length > 1 && SUFFIX_WORDS.has(t[t.length - 1])) t.pop();
  const slug = t.join("");
  if (slug && slug !== "unknown") return slug;
  const fromDomain = tokens(domainCompanyName(domain)).join("");
  return fromDomain || "unknown";
}

/** Grouping key for a stored Tracker row: recomputed from the company NAME so
 *  rows ingested under older keying rules regroup without a data rewrite.
 *  Rows with an "Unknown" company keep their stored key (a domain fallback). */
export function groupKeyFor(row: { company: string; companyKey: string }): string {
  const fromName = companyKeyFor(row.company);
  if (fromName !== "unknown") return fromName;
  const stored = (row.companyKey || "").toLowerCase().trim();
  if (stored.includes(".")) return companyKeyFor("", stored);
  return stored || "unknown";
}

// Levenshtein distance ≤1 check (used to merge AI spelling variants of one company).
function within1Edit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else {
      i++;
      j++;
    }
  }
  if (i < la || j < lb) edits++;
  return edits <= 1;
}

/**
 * Two company keys are the same company if they differ by ≤1 edit (spelling
 * variant: appflyer ↔ appsflyer) or one contains the other ("productmanager-
 * checkpoint" ⊃ "checkpoint"). Both rules need a length floor: short keys are
 * distinct brands ("lema" vs "lama", "glow" vs "flow"), and "papaya" (Papaya
 * Gaming) ⊂ "papayaglobal" (Papaya Global) are DIFFERENT employers.
 */
export function sameCompany(a: string, b: string): boolean {
  if (a === "unknown" || b === "unknown") return false;
  if (a === b) return true;
  if (a.length >= 6 && b.length >= 6 && within1Edit(a, b)) return true;
  if (a.length >= 7 && b.length >= 7 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

export interface KnownCompany {
  key: string;
  name: string;
}

// Keys that are extraction junk — never snap new mail onto them.
export const UNSNAPPABLE = new Set(["unknown", "various", "mail", "us", "eu", "greenhouse", "comeet", "workday", "lever"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Attach an email to a company we ALREADY track when the evidence points
 * there, so a rejection signed by a recruiter ("Tamar Dekel Romano") or relayed
 * by an ATS ("us.greenhouse-mail.io") lands on the application's card:
 *   1. the extracted name is a spelling/suffix variant of a known company;
 *   2. the subject names a known company (longest match wins);
 *   3. the sender domain IS a known company's domain.
 * Otherwise the extracted name stands (a genuinely new company).
 */
export function snapToKnown(
  company: string,
  msg: { subject: string; senderDomain: string },
  known: KnownCompany[],
): { company: string; companyKey: string } {
  const key = companyKeyFor(company, msg.senderDomain);
  const candidates = known.filter((k) => !UNSNAPPABLE.has(k.key) && k.key.length >= 3);

  const variant =
    candidates.find((k) => k.key === key) ?? candidates.find((k) => sameCompany(k.key, key));
  if (variant) return { company: variant.name, companyKey: variant.key };

  const subject = msg.subject || "";
  const inSubject = candidates
    .filter((k) => {
      const name = k.name.trim();
      if (name.length < 4) return false;
      // Short names must match case-exactly ("NICE" ≠ "nice to meet you").
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name)}($|[^\\p{L}\\p{N}])`, name.length >= 6 ? "iu" : "u");
      return re.test(subject);
    })
    .sort((a, b) => b.key.length - a.key.length)[0];
  if (inSubject) return { company: inSubject.name, companyKey: inSubject.key };

  const domainKey = tokens(domainCompanyName(msg.senderDomain)).join("");
  const byDomain = domainKey ? candidates.find((k) => k.key === domainKey) : undefined;
  if (byDomain) return { company: byDomain.name, companyKey: byDomain.key };

  return { company, companyKey: key };
}

/** Known companies from existing rows: canonical key → most frequent name. */
export function knownCompanies(rows: { company: string; companyKey: string }[]): KnownCompany[] {
  const names = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const name = (r.company || "").trim();
    // Email-address "names" are extractor junk — never offer them as a label.
    if (!name || name.toLowerCase() === "unknown" || name.includes("@")) continue;
    const key = groupKeyFor(r);
    const m = names.get(key) ?? new Map<string, number>();
    m.set(name, (m.get(name) ?? 0) + 1);
    names.set(key, m);
  }
  return [...names].map(([key, m]) => ({
    key,
    name: [...m].sort((a, b) => b[1] - a[1])[0][0],
  }));
}

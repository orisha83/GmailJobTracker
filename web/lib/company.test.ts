import { describe, it, expect } from "vitest";
import {
  companyKeyFor,
  domainCompanyName,
  groupKeyFor,
  knownCompanies,
  sameCompany,
  snapToKnown,
} from "./company";

describe("companyKeyFor — one key per employer", () => {
  it.each([
    ["Armis Security", "armis"],
    ["Akamai Technologies", "akamai"],
    ["DoiT International", "doit"],
    ["Glow Hiring Team", "glow"],
    ["Ethos AI", "ethos"],
    ["mprest.com", "mprest"],
    ["Check Point Software Technologies", "checkpoint"],
    ["Stigg Product Manager", "stigg"],
    ["Mind Security Inc.", "mind"],
  ])("%s → %s", (name, key) => {
    expect(companyKeyFor(name)).toBe(key);
  });

  it("never strips the only word (a company literally called 'Security' stays)", () => {
    expect(companyKeyFor("Security")).toBe("security");
  });

  it("keeps distinct brands distinct (Papaya Gaming vs Papaya Global)", () => {
    expect(companyKeyFor("Papaya Gaming")).not.toBe(companyKeyFor("Papaya Global"));
  });

  it("falls back to the sender domain's company when the name is unknown", () => {
    expect(companyKeyFor("Unknown", "mprest.com")).toBe("mprest");
    expect(companyKeyFor("", "mail.amazon.jobs")).toBe("amazon");
  });
});

describe("domainCompanyName — ATS-aware", () => {
  it.each([
    ["gong.io", "Gong"],
    ["mail.amazon.jobs", "Amazon"],
    ["onestep.comeet-notifications.com", "Onestep"],
    ["quantum.art.comeet-notifications.com", "Quantum Art"],
    ["us.greenhouse-mail.io", ""], // relay only — no employer in the domain
    ["eu.greenhouse-mail.io", ""],
    ["myworkday.com", ""],
    ["gmail.com", ""],
    ["company.co.il", "Company"],
  ])("%s → %j", (domain, name) => {
    expect(domainCompanyName(domain)).toBe(name);
  });
});

describe("sameCompany", () => {
  it("merges spelling variants of longer names", () => {
    expect(sameCompany("appflyer", "appsflyer")).toBe(true);
  });
  it("does NOT fuzzy-merge short distinct brands", () => {
    expect(sameCompany("lema", "lama")).toBe(false);
    expect(sameCompany("glow", "flow")).toBe(false);
  });
  it("still keeps Papaya Gaming and Papaya Global apart", () => {
    expect(sameCompany("papaya", "papayaglobal")).toBe(false);
  });
});

describe("groupKeyFor — regroups old rows without rewriting them", () => {
  it("derives the key from the company name, not the stored key", () => {
    expect(groupKeyFor({ company: "Armis Security", companyKey: "armissecurity" })).toBe("armis");
  });
  it("keeps the stored (domain) key for Unknown-company rows, normalized", () => {
    expect(groupKeyFor({ company: "Unknown", companyKey: "mprest.com" })).toBe("mprest");
  });
});

describe("snapToKnown — attach new mail to a tracked company", () => {
  const known = [
    { key: "gong", name: "Gong" },
    { key: "tokensecurity", name: "Token Security" },
    { key: "token", name: "Token Security" },
    { key: "viber", name: "Viber" },
    { key: "nice", name: "NICE" },
    { key: "us", name: "Us" },
  ];

  it("a spelling/suffix variant joins the known company", () => {
    expect(snapToKnown("Gong.io", { subject: "", senderDomain: "" }, known).companyKey).toBe("gong");
  });

  it("a subject naming a known company wins over a recruiter's name", () => {
    const r = snapToKnown(
      "Tamar Dekel Romano",
      { subject: "Thank you for considering Gong, Ori", senderDomain: "" },
      known,
    );
    expect(r).toEqual({ company: "Gong", companyKey: "gong" });
  });

  it("the sender's corporate domain matches a known company", () => {
    const r = snapToKnown("Someone", { subject: "Hello", senderDomain: "gong.io" }, known);
    expect(r.companyKey).toBe("gong");
  });

  it("short names match the subject case-exactly only", () => {
    const r = snapToKnown("Acme", { subject: "nice to meet you", senderDomain: "acme.com" }, known);
    expect(r.companyKey).toBe("acme");
  });

  it("never snaps onto junk keys like 'us'", () => {
    const r = snapToKnown("Us", { subject: "Us update", senderDomain: "" }, known);
    expect(r.companyKey).toBe("us"); // stays itself, does not attach elsewhere either
  });

  it("an unrelated company stays new", () => {
    const r = snapToKnown("Acme", { subject: "Your application to Acme", senderDomain: "acme.com" }, known);
    expect(r).toEqual({ company: "Acme", companyKey: "acme" });
  });
});

describe("knownCompanies", () => {
  it("keys by canonical key with the most frequent display name", () => {
    const k = knownCompanies([
      { company: "Armis Security", companyKey: "armissecurity" },
      { company: "Armis", companyKey: "armis" },
      { company: "Armis", companyKey: "armis" },
      { company: "Unknown", companyKey: "unknown" },
    ]);
    expect(k).toEqual([{ key: "armis", name: "Armis" }]);
  });
});

describe("email-address company names (old extractor fallback)", () => {
  it.each([
    ["no-replycareers@payoneer.com", "payoneer"],
    ["BitSight@myworkday.com", "bitsight"],
    ["no-reply@us.greenhouse-mail.io", "unknown"],
  ])("%s → %s", (name, key) => {
    expect(companyKeyFor(name)).toBe(key);
  });
});

it("Hebrew company names get their own key (not 'unknown')", () => {
  expect(companyKeyFor("אלביט מערכות")).toBe("אלביטמערכות");
});

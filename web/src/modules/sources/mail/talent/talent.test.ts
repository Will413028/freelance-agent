import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JobInput } from "@/modules/listings/public";
import type { MailMessage } from "../message";
import { MailRejection } from "../reasons";
import { isAlertSubject, jobOf, parseTalent, SENDER } from ".";

// Plan step 7b: the Talent.com job alert. fixtures/cases.json holds the 59 alerts and fixtures/links.json
// the 18 links the old parser read (its talent_parse and talent_canonical ground-truth cases at ce1254d),
// expected results mapped field by field (salary_text → compensation_evidence, language → extra.language);
// the deliberate differences are named in the case names.

type Case = { name: string; message: Omit<MailMessage, "id" | "receivedAt">; expect: { listings: unknown[] } | { reason: string } };
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8"));
const cases = fixture<Case[]>("cases.json");
const links = fixture<{ name: string; href: string; expect: [string, string] | null }[]>("links.json");

type Outcome = { listings: JobInput[]; reason?: undefined } | { reason: string; listings?: undefined };
const outcome = (m: Omit<MailMessage, "id" | "receivedAt">): Outcome => {
  try {
    return { listings: parseTalent({ ...m, sender: m.sender.toLowerCase(), id: "x", receivedAt: "2026-09-26T03:00:00.000Z" }) };
  } catch (e) {
    if (e instanceof MailRejection) return { reason: e.reason };
    throw e;
  }
};

const LINK = "https://tw.talent.com/redirect?id=abcdef123456";
const card = (href = LINK, close = "</a>") => `<a href="${href}">
<!-- Title --><a class="job__link" href="${href}&amp;user_id=private">Backend API Engineer</a>
<!-- Location --><td>Taiwan</td><!-- Company --><td>Example</td>
<!-- Salary --><td>NT$1,000/hr</td><!-- Description --><td>Contractor building APIs...</td>${close}`;
const alert = (body: string) => ({ sender: SENDER, subject: "更多职位，例如Software Engineer", isHtml: true, body });

describe("talent alert", () => {
  it(`${cases.length} old alerts give the expected listings or rejection`, () => {
    const wrong = cases.filter((c) => JSON.stringify(outcome(c.message)) !== JSON.stringify(c.expect)).map((c) => c.name);
    expect(wrong).toEqual([]);
  });

  it(`${links.length} old links give the expected job or none`, () => {
    expect(links.filter((c) => JSON.stringify(jobOf(c.href)) !== JSON.stringify(c.expect)).map((c) => c.name)).toEqual([]);
  });

  it("gives one id for the same job however the link is written (host case, default port, whitespace, other query fields)", () => {
    const hrefs = ["https://TW.talent.com/redirect?id=abcdef123456", "https://tw.talent.com:443/redirect?id=abcdef123456", ` ${LINK} `, `${LINK}&utm=x`];
    expect(hrefs.map((h) => jobOf(h))).toEqual(Array(4).fill(["abcdef123456", "https://tw.talent.com/view?id=abcdef123456"]));
  });

  it("refuses a link the body never closed, which the HTML parser would close for it (a cut-off alert)", () => {
    expect(outcome(alert(card()))).toMatchObject({ listings: [{ external_id: "abcdef123456" }] });
    expect(outcome(alert(card(LINK, "")))).toEqual({ reason: "talent_unbalanced" });
  });

  it("refuses a described card whose outer link names another job than its job__link", () => {
    const mixed = card().replace(`<a href="${LINK}">`, `<a href="https://tw.talent.com/redirect?id=111111111111">`);
    expect(outcome(alert(mixed))).toEqual({ reason: "talent_card_link" });
  });

  it("refuses a card-only section that closes a row opened before it", () => {
    const base = cases.find((c) => c.name === "old 2")!.message;
    expect(outcome(base).listings).toHaveLength(1);
    const escaped = { ...base, body: `<table><tr><td>${base.body.replace("<!-- Job cards -->", "<!-- Job cards --></td></tr>")}</table>` };
    expect(outcome(escaped)).toEqual({ reason: "talent_unbalanced" });
  });

  it("keeps the salary as evidence and unknowns unknown", () => {
    expect(outcome(alert(card())).listings?.[0]).toMatchObject({
      compensation_evidence: "NT$1,000/hr", location: "Taiwan", kind: "contract", complete: false,
      budget_min: null, weekly_hours: null, taiwan_eligible: null, deadline: null, extra: { language: "en" },
    });
  });

  it("gates the inbox list on the two alert subjects", () => {
    expect(["更多职位，例如Software Engineer", "Software Engineer - Taipei jobs you don't want to miss", "Your Talent.com account"].map(isAlertSubject))
      .toEqual([true, true, false]);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ListingInput } from "@/modules/listings/public";
import type { MailMessage } from "../message";
import { MailRejection } from "../reasons";
import { isJobSubject, listingOf, parseGlassdoor, SENDER } from ".";

// Plan step 7b: the Glassdoor job alert. fixtures/cases.json holds the 43 alerts and fixtures/links.json
// the 17 links the old parser read (its glassdoor_parse and glassdoor_canonical ground-truth cases at
// ce1254d), expected results mapped field by field (language → extra.language); the deliberate
// differences are named in the case names.

type Case = { name: string; message: Omit<MailMessage, "id" | "receivedAt">; expect: { listings: unknown[] } | { reason: string } };
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8"));
const cases = fixture<Case[]>("cases.json");
const links = fixture<{ name: string; href: string; expect: [string, string] | null }[]>("links.json");

type Outcome = { listings: ListingInput[]; reason?: undefined } | { reason: string; listings?: undefined };
const outcome = (m: Omit<MailMessage, "id" | "receivedAt">): Outcome => {
  try {
    return { listings: parseGlassdoor({ ...m, sender: m.sender.toLowerCase(), id: "x", receivedAt: "2026-09-26T03:00:00.000Z" }) };
  } catch (e) {
    if (e instanceof MailRejection) return { reason: e.reason };
    throw e;
  }
};

const ID = "1010273135749";
const LINK = `https://www.glassdoor.com/partner/jobListing.htm?jobListingId=${ID}`;
const card = (inner = "<td><p>Contract AI Engineer</p></td><td><p>2d</p></td>") =>
  `<a href="${LINK}&amp;tracking=private"><table><tr><td><span>Example Co</span></td></tr><tr>${inner}</tr></table></a>`;
const alert = (body: string) => ({ sender: SENDER, subject: "All the top jobs for Software Engineer in Taiwan. Ready to apply?", isHtml: true, body });

describe("glassdoor alert", () => {
  it(`${cases.length} old alerts give the expected listings or rejection`, () => {
    const wrong = cases.filter((c) => JSON.stringify(outcome(c.message)) !== JSON.stringify(c.expect)).map((c) => c.name);
    expect(wrong).toEqual([]);
  });

  it(`${links.length} old links give the expected listing or none`, () => {
    expect(links.filter((c) => JSON.stringify(listingOf(c.href)) !== JSON.stringify(c.expect)).map((c) => c.name)).toEqual([]);
  });

  it("gives one id for the same listing however the link is written (host case, default port, whitespace, tracking)", () => {
    const hrefs = [LINK.replace("www.glassdoor", "WWW.Glassdoor"), LINK.replace(".com/", ".com:443/"), ` ${LINK} `, `${LINK}&src=GD_JOB_AD`];
    expect(hrefs.map(listingOf)).toEqual(Array(4).fill([ID, LINK]));
  });

  it("refuses a card the body never closed, and a paragraph opened inside another", () => {
    expect(outcome(alert(card()))).toMatchObject({ listings: [{ external_id: ID, title: "Contract AI Engineer", company: "Example Co", kind: "contract" }] });
    expect(outcome(alert(card().replace(/<\/a>$/u, "")))).toEqual({ reason: "glassdoor_incomplete_card" });
    expect(outcome(alert(card("<td><p>Contract AI Engineer<p>2d</p></td>")))).toEqual({ reason: "glassdoor_incomplete_card" });
  });

  it("names a link inside a card as nested, not as an incomplete card", () => {
    expect(outcome(alert(card().replace("<span>Example Co</span>", `<span>Example Co <a href="https://example.test/">x</a></span>`)))).toEqual({ reason: "glassdoor_nested_link" });
  });

  it("refuses a paragraph nested in a span inside another, and a misnested company span", () => {
    expect(outcome(alert(card("<td><p>Senior <span><p>AI Engineer</p></span></p></td><td><p>2d</p></td>")))).toEqual({ reason: "glassdoor_incomplete_card" });
    // A stray </span> is dropped by the parser; a misnested one closes the span for the body.
    expect(outcome(alert(card().replace("<span>Example Co</span>", "<b><span>Example Co</b></span>")))).toEqual({ reason: "glassdoor_incomplete_card" });
  });

  it("counts the title and company limits in characters, not UTF-16 units", () => {
    const title = "😀".repeat(600);
    expect(outcome(alert(card(`<td><p>${title}</p></td><td><p>2d</p></td>`))).listings?.[0].title).toBe(title);
  });

  it("keeps the relative age out of published_at and unknowns unknown", () => {
    expect(outcome(alert(card())).listings?.[0]).toMatchObject({
      published_at: null, location: null, complete: false, budget_min: null, weekly_hours: null, taiwan_eligible: null, deadline: null, extra: { language: "en" },
    });
  });

  it("gates the inbox list on the two alert subjects", () => {
    expect([
      "All the top jobs for Software Engineer in Taiwan. Ready to apply?",
      "AI Engineer at Example Co and 12 more jobs in Taipei for you. Apply Now.",
      "Your Glassdoor account",
    ].map(isJobSubject)).toEqual([true, true, false]);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ListingInput } from "@/modules/listings/public";
import { readMessage, type MailMessage } from "../message";
import { MailRejection } from "../reasons";
import { isAlertSubject, jobOf, LINKEDIN_SETTINGS, parseLinkedin, SENDER } from ".";

// Plan step 7b: the LinkedIn job alert's text part. fixtures/cases.json holds the 75 messages the old
// parser read (its linkedin_parse ground-truth cases at ce1254d), expected results mapped field by field
// (location_evidence → location; language and remote_evidence → extra); the deliberate differences are
// named in the case names.

type Case = { name: string; message: Omit<MailMessage, "id" | "receivedAt">; expect: { listings: unknown[] } | { reason: string } };
const cases: Case[] = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));

type Outcome = { listings: ListingInput[]; reason?: undefined } | { reason: string; listings?: undefined };
const outcome = (m: Omit<MailMessage, "id" | "receivedAt">): Outcome => {
  try {
    return { listings: parseLinkedin({ ...m, sender: m.sender.toLowerCase(), id: "x", receivedAt: "2026-09-26T03:00:00.000Z" }) };
  } catch (e) {
    if (e instanceof MailRejection) return { reason: e.reason };
    throw e;
  }
};

const VIEW = "https://www.linkedin.com/comm/jobs/view/1234/?trackingId=private";
const TEXT = `Your job alert for backend in Asia
New jobs match your preferences.
Contract Backend Engineer (Remote)
Example Co
Singapore
View job: ${VIEW}
---------------------------------------------------------
See all jobs on LinkedIn: https://www.linkedin.com/jobs/`;
const text = (body = TEXT, subject = "Example is hiring") => ({ sender: SENDER, subject, isHtml: false, body });

describe("linkedin alert", () => {
  it("reads the template without a count line (seen since 2026-10): cards start on the second line", () => {
    const body = TEXT.replace("New jobs match your preferences.\n", "").replace("See all", `Second Role\nOther Co\nTaipei\nThis company is actively hiring\nView job: https://www.linkedin.com/comm/jobs/view/5678/\n---------------------------------------------------------\nSee all`);
    const got = outcome(text(body));
    expect(got.listings?.map((l) => [l.external_id, l.title, l.company, l.location])).toEqual([["1234", "Contract Backend Engineer (Remote)", "Example Co", "Singapore"], ["5678", "Second Role", "Other Co", "Taipei"]]);
    for (const bad of ["0 new jobs match your preferences.", "14 new jobs match your preferences", "Recommended content for you."]) {
      expect(outcome(text(TEXT.replace("New jobs match your preferences.", bad))).reason, bad).toBe("linkedin_template");
    }
    // A title that only mentions preferences or recommended content is a card, not a count line.
    for (const title of ["Recommended Content Strategist", "Senior Engineer, User Preferences Platform"]) {
      expect(outcome(text(body.replace("Contract Backend Engineer (Remote)", title))).listings?.[0]?.title, title).toBe(title);
    }
    // A manage link right after the first line is checked as one.
    const manage = (url: string) => outcome(text(body.replace("\nContract Backend", `\nManage alerts: ${url}\nContract Backend`)));
    expect(manage("https://www.linkedin.com/comm/jobs/alerts?utm=preferences").listings).toHaveLength(2);
    expect(manage("https://evil.example/comm/jobs/alerts").reason).toBe("linkedin_manage_link");
  });

  it(`${cases.length} old messages give the expected listings or rejection`, () => {
    const wrong = cases.filter((c) => JSON.stringify(outcome(c.message)) !== JSON.stringify(c.expect)).map((c) => c.name);
    expect(wrong).toEqual([]);
  });

  it("gives one id for the same job however the link is written (/comm/, host case, default port, whitespace, tracking)", () => {
    const hrefs = [VIEW, "https://WWW.linkedin.com/jobs/view/1234", "https://www.linkedin.com:443/jobs/view/1234/", " https://www.linkedin.com/jobs/view/1234/ "];
    expect(hrefs.map((h) => jobOf(h))).toEqual(Array(4).fill(["1234", "https://www.linkedin.com/jobs/view/1234/"]));
    expect(outcome(text(TEXT.replace(VIEW, ` ${VIEW} `))).listings?.[0].external_id).toBe("1234");
  });

  it("reads the text part of a message that also has HTML (the settings prefer text)", () => {
    const raw = { id: "m1", from: `LinkedIn <${SENDER}>`, to: ["inbox@example.test"], created_at: "2026-11-17T01:00:00Z", subject: "Example is hiring", html: "<p>HTML part</p>", text: TEXT };
    const message = readMessage(raw, "m1", SENDER, "inbox@example.test", LINKEDIN_SETTINGS.preferText);
    expect(parseLinkedin(message).map((l) => l.external_id)).toEqual(["1234"]);
  });

  it("refuses a link whose dot segments or backslashes would resolve to another job, as the old parser did", () => {
    for (const href of ["https://www.linkedin.com/jobs/view/999/../1234/", "https://www.linkedin.com/jobs/./view/1234/", "https:\\\\www.linkedin.com\\jobs\\view\\1234"]) expect(jobOf(href)).toBeNull();
    expect(outcome(text(TEXT.replace(VIEW, "https://www.linkedin.com/jobs/view/999/../1234/")))).toEqual({ reason: "linkedin_job_link" });
  });

  it("strips lines as Python did: a leading BOM stays and refuses the template", () => {
    expect(outcome(text(`\ufeff${TEXT}`))).toEqual({ reason: "linkedin_template" });
  });

  it("records a turned-off-alert notice as no listings, not as a rejection", () => {
    expect(outcome(text("Your alert is off.", "We’ve turned off your job alert for backend in Asia"))).toEqual({ listings: [] });
  });

  it("keeps the location and remote wording as evidence, never as eligibility", () => {
    expect(outcome(text()).listings?.[0]).toMatchObject({
      location: "Singapore", kind: "contract", complete: false, taiwan_eligible: null, timezone_compatible: null, budget_min: null, weekly_hours: null,
      extra: { language: "en", remote_evidence: true },
    });
  });

  it("gates the inbox list: everything but the alert-created confirmation", () => {
    expect(["Example is hiring", "Your job alert for backend has been created"].map(isAlertSubject)).toEqual([true, false]);
  });
});

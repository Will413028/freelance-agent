import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ListingInput } from "@/modules/listings/public";
import type { MailMessage } from "../message";
import { MailRejection } from "../reasons";
import { isDigestSubject, parse104, SENDER } from ".";

// Plan step 7a: the 104 matching digest. fixtures/cases.json holds the 40 digests the old Python parser
// read, written by fixtures/generate.ts (deleted in step 11 with the old ground-truth file; see it at 9113a44): expected listings from
// the old results, mapped field by field; the 3 deliberate differences are named in their case names.

type Case = { name: string; message: Omit<MailMessage, "id" | "receivedAt">; expect: { listings: unknown[] } | { reason: string } };
const cases: Case[] = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));

type Outcome = { listings: ListingInput[]; reason?: undefined } | { reason: string; listings?: undefined };
const outcome = (m: Omit<MailMessage, "id" | "receivedAt">): Outcome => {
  try {
    return { listings: parse104({ ...m, sender: m.sender.toLowerCase(), id: "x", receivedAt: "2026-09-26T03:00:00.000Z" }) };
  } catch (e) {
    if (e instanceof MailRejection) return { reason: e.reason };
    throw e;
  }
};

const SUBJECT = "測試09/26的配對日報，符合職缺1筆";
const card = (job = "https://www.104.com.tw/job/abc123?tracking=private", company = "https://www.104.com.tw/company/c1") =>
  `<a href="${job}">兼職 Backend API 工程師</a><a href="${company}">Example</a><p>台北市</p><a href="https://104app.onelink.me/zB8j/apply?t=1">我要應徵</a>`;
const digest = (body: string, subject = SUBJECT) => ({ sender: SENDER, subject, isHtml: true, body: `${body}<h2>適合你大展身手的工作</h2>` });

describe("jobbank104 digest", () => {
  it(`${cases.length} old digests give the expected listings or rejection`, () => {
    const wrong = cases.filter((c) => JSON.stringify(outcome(c.message)) !== JSON.stringify(c.expect)).map((c) => c.name);
    expect(wrong).toEqual([]);
  });

  it("gives one id for the same job however the link is written (host case, default port, query)", () => {
    const ids = ["https://WWW.104.com.tw/job/abc123", "https://www.104.com.tw:443/job/abc123?x=1", " https://www.104.com.tw/job/abc123#top "]
      .map((href) => outcome(digest(card(href))));
    expect(ids.map((o) => (o.listings ? o.listings.map((l) => [l.external_id, l.url]) : o.reason)))
      .toEqual(Array(3).fill([["abc123", "https://www.104.com.tw/job/abc123"]]));
  });

  it("names the failed check: a job link off 104, a second job before the apply link, a malformed href", () => {
    expect(outcome(digest(card("http://www.104.com.tw/job/abc123")))).toEqual({ reason: "104_unsupported_job_link" });
    const twoJobs = `<a href="https://www.104.com.tw/job/a1">兼職 A</a>${card()}`;
    expect(outcome(digest(twoJobs, "測試09/26的配對日報，符合職缺2筆"))).toEqual({ reason: "104_incomplete_card" });
    expect(outcome(digest(`${card()}<a href="https://[bad">x</a>`))).toEqual({ reason: "104_invalid_link" });
    for (const relative of ["/job/abc123", "//www.104.com.tw/job/abc123"]) expect(outcome(digest(card(relative)))).toEqual({ reason: "104_unsupported_job_link" });
  });

  it("keeps unknowns unknown: no budget, hours, eligibility or publish time is guessed", () => {
    const o = outcome(digest(card()));
    expect(o.listings?.[0]).toMatchObject({ kind: "contract", complete: false, budget_min: null, weekly_hours: null, taiwan_eligible: null, published_at: null, deadline: null });
  });

  it("gates the inbox list on the digest subject", () => {
    expect([isDigestSubject(SUBJECT), isDigestSubject("驗證通知"), isDigestSubject(`${SUBJECT}\n`)]).toEqual([true, false, false]);
  });
});

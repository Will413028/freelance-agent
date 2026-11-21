import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { JobInput } from "@/modules/listings/public";
import type { MailMessage } from "../message";
import { MailRejection } from "../reasons";
import { isJobSubject, jobPage, parseCake, SENDER } from ".";

// Plan step 7b: the Cake followed-company notification. fixtures/cases.json holds the 35 notifications and
// fixtures/links.json the 51 links the old parser read (its cake_parse and cake_canonical ground-truth
// cases at ce1254d), expected results mapped field by field (external_id: the old full URL becomes
// `<company>/<job>`, plan D10; language → extra.language); the deliberate differences are named in the
// case names.

type Case = { name: string; message: Omit<MailMessage, "id" | "receivedAt">; expect: { listings: unknown[] } | { reason: string } };
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8"));
const cases = fixture<Case[]>("cases.json");
const links = fixture<{ name: string; href: string; expect: [string, string] | null }[]>("links.json");

type Outcome = { listings: JobInput[]; reason?: undefined } | { reason: string; listings?: undefined };
const outcome = (m: Omit<MailMessage, "id" | "receivedAt">): Outcome => {
  try {
    return { listings: parseCake({ ...m, sender: m.sender.toLowerCase(), id: "x", receivedAt: "2026-09-26T03:00:00.000Z" }) };
  } catch (e) {
    if (e instanceof MailRejection) return { reason: e.reason };
    throw e;
  }
};

const JOB = "https://www.cake.me/companies/example/jobs/backend-api";
const SUBJECT = "您追蹤的 Example 刊登了一筆新職缺 - 兼職 Backend API 工程師";
const mail = (body: string, subject = SUBJECT) => ({ sender: SENDER, subject, isHtml: true, body });
const tracker = (query: string) => `https://email.no-reply.cake.me/c/${deflateSync(Buffer.from(query)).toString("base64url")}`;

describe("cake notification", () => {
  it(`${cases.length} old notifications give the expected listing or rejection`, () => {
    const wrong = cases.filter((c) => JSON.stringify(outcome(c.message)) !== JSON.stringify(c.expect)).map((c) => c.name);
    expect(wrong).toEqual([]);
  });

  it(`${links.length} old links give the expected job page or none`, () => {
    expect(links.filter((c) => JSON.stringify(jobPage(c.href)) !== JSON.stringify(c.expect)).map((c) => c.name)).toEqual([]);
  });

  it("gives one id for the same job however the link is written (host case, default port, whitespace, slash, tracker)", () => {
    const hrefs = ["https://WWW.cake.me/companies/example/jobs/backend-api", "https://www.cake.me:443/companies/example/jobs/backend-api/",
      ` ${JOB} `, "https://cake.me/companies/example/jobs/backend-api?ref=mail", tracker(`l=${encodeURIComponent(JOB)}`)];
    expect(hrefs.map((h) => outcome(mail(`<a href="${h}">了解詳情</a>`)).listings?.map((l) => [l.external_id, l.url])))
      .toEqual(Array(5).fill([["example/backend-api", JOB]]));
  });

  it("decodes the tracker without visiting it, and refuses one that does not name exactly one Cake job", () => {
    expect(jobPage(tracker(`l=${JOB}&l=`))).toEqual([JOB, "example/backend-api"]);
    expect(jobPage(tracker(`l=${JOB}&l=${JOB}`))).toBeNull();
    expect(jobPage(tracker("l=https://evil.test/companies/a/jobs/b"))).toBeNull();
    expect(jobPage(`${tracker(`l=${JOB}`)}?x=1`)).toBeNull();
  });

  it("names the failed check", () => {
    expect(outcome({ ...mail(`<a href="${JOB}">了解詳情</a>`), sender: "other@cake.me" })).toEqual({ reason: "cake_unsupported" });
    expect(outcome(mail(`<a href="${JOB}">了解詳情</a>`, "New message"))).toEqual({ reason: "cake_subject" });
    expect(outcome(mail(`<a href="${JOB}">了解詳情<a href="x">y</a></a>`))).toEqual({ reason: "cake_nested_link" });
    expect(outcome(mail(`<a href="https://evil.test/x">了解詳情</a>`))).toEqual({ reason: "cake_job_link" });
    expect(outcome(mail(`<a href="${JOB}">看看</a>`))).toEqual({ reason: "cake_job_link_count" });
    expect(outcome(mail(`<a href="${JOB}">了解詳情</a><a href="${JOB}-2">了解詳情</a>`))).toEqual({ reason: "cake_job_link_count" });
  });

  it("keeps unknowns unknown: a summary only, no budget, hours, eligibility or deadline is guessed", () => {
    expect(outcome(mail(`<a href="${JOB}">了解詳情</a>`)).listings?.[0]).toMatchObject({
      kind: "contract", complete: false, budget_min: null, weekly_hours: null, taiwan_eligible: null, published_at: null, deadline: null, extra: { language: "zh-TW" },
    });
  });

  it("reads a subject carrying \\r or U+2028 as the old pattern did (only \\n ends it)", () => {
    const body = `<a href="${JOB}">了解詳情</a>`;
    expect(outcome(mail(body, "您追蹤的 Example 刊登了一筆新職缺 - A\rB")).listings?.[0].title).toBe("A\rB");
    expect(outcome(mail(body, "您追蹤的 Example 刊登了一筆新職缺 - A\nB"))).toEqual({ reason: "cake_subject" });
  });

  it("gates the inbox list on the job notification subject", () => {
    expect([SUBJECT, "Cake 帳號通知", "您有一則新訊息"].map(isJobSubject)).toEqual([true, false, false]);
  });
});

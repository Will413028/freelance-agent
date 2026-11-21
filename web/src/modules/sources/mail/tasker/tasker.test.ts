import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JobInput } from "@/modules/listings/public";
import type { MailMessage } from "../message";
import { MailRejection } from "../reasons";
import { isCaseSubject, parseTasker, SENDER } from ".";

// Plan step 7b: the Tasker case notification. fixtures/cases.json holds the 66 notifications the old
// parser read (its tasker_parse ground-truth cases at ce1254d), expected listings mapped field by field from the
// old results (observed_amount → compensation_evidence, language → extra.language); the 7 deliberate differences are named in their
// case names. Old refusals expect the new parser's reason code (the old raised one error class).

type Case = { name: string; message: Omit<MailMessage, "id" | "receivedAt">; expect: { listings: unknown[] } | { reason: string } };
const cases: Case[] = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/cases.json"), "utf8"));

type Outcome = { listings: JobInput[]; reason?: undefined } | { reason: string; listings?: undefined };
const outcome = (m: Omit<MailMessage, "id" | "receivedAt">): Outcome => {
  try {
    return { listings: parseTasker({ ...m, sender: m.sender.toLowerCase(), id: "x", receivedAt: "2026-09-17T00:00:00.000Z" }) };
  } catch (e) {
    if (e instanceof MailRejection) return { reason: e.reason };
    throw e;
  }
};

const html = (href = "https://www.tasker.com.tw/cases/Ab123?private=fake", amount = "<p>$100,000</p>") => ({
  sender: SENDER, subject: "新案件【測試網站】", isHtml: true,
  body: `<p>2026/09/17 最新案件，限時搶先提案！</p><h2>測試網站</h2>${amount}<h3>需求說明</h3><p>串接 API。</p><a href="${href}">查看完整資訊</a><p>FOOTER</p>`,
});

describe("tasker notification", () => {
  it(`${cases.length} old notifications give the expected listing or rejection`, () => {
    const wrong = cases.filter((c) => JSON.stringify(outcome(c.message)) !== JSON.stringify(c.expect)).map((c) => c.name);
    expect(wrong).toEqual([]);
  });

  it("gives one id for the same case however the link is written (host case, default port, query)", () => {
    const ids = ["https://WWW.tasker.com.tw/cases/Ab123", "https://www.tasker.com.tw:443/cases/Ab123?x=1", "https://www.tasker.com.tw/cases/Ab123#top", " https://www.tasker.com.tw/cases/Ab123 "]
      .map((href) => outcome(html(href)));
    expect(ids.map((o) => (o.listings ? o.listings.map((l) => [l.external_id, l.url]) : o.reason)))
      .toEqual(Array(4).fill([["Ab123", "https://www.tasker.com.tw/cases/Ab123"]]));
  });

  it("names the failed check: sender, no call-to-action link, a second case, the subject, the body", () => {
    expect(outcome({ ...html(), sender: "other@tasker.com.tw" })).toEqual({ reason: "tasker_unsupported" });
    expect(outcome(html("http://www.tasker.com.tw/cases/Ab123"))).toEqual({ reason: "tasker_boundary" });
    const two = html();
    two.body += `<a href="https://www.tasker.com.tw/cases/Zz999">另一案</a>`;
    expect(outcome(two)).toEqual({ reason: "tasker_case_link" });
    expect(outcome({ ...html(), subject: "新案件" })).toEqual({ reason: "tasker_subject" });
    expect(outcome(html(undefined, "<p>面議</p>"))).toEqual({ reason: "tasker_body" });
  });

  it("keeps the amount as evidence and unknowns unknown: no budget, kind, hours or eligibility is guessed", () => {
    expect(outcome(html()).listings?.[0]).toMatchObject({ compensation_evidence: "$100,000", complete: false, kind: null, budget_min: null, weekly_hours: null, taiwan_eligible: null, published_at: null, deadline: null });
    expect(outcome(html(undefined, "<p>預算詳談</p>")).listings?.[0].compensation_evidence).toBeNull();
    expect(outcome(html()).listings?.[0].extra).toEqual({ language: "zh-TW" });
  });

  it("keeps a domain in the title, while the body header is matched without it", () => {
    const m = html();
    m.subject = "新案件【www.shop.example 網站】";
    m.body = m.body.replace("<h2>測試網站</h2>", "<h2>www.shop.example 網站</h2>");
    expect(outcome(m).listings?.[0].title).toBe("www.shop.example 網站");
  });

  it("reads a CRLF text part like an LF one", () => {
    const body = "2026/09/17 最新案件，限時搶先提案！\n測試網站\n$100,000\n需求說明\n串接 API\n查看完整資訊 https://www.tasker.com.tw/cases/Ab123\nFOOTER";
    const text = (b: string) => outcome({ sender: SENDER, subject: "新案件【測試網站】", isHtml: false, body: b });
    expect(text(body.replaceAll("\n", "\r\n"))).toEqual(text(body));
    expect(text(body).listings?.[0].external_id).toBe("Ab123");
  });

  it("gates the inbox list on a subject naming exactly one 【title】 (news and promotions are not read)", () => {
    expect(["新案件【測試網站】", "Tasker 電子報", "【a】【b】"].map(isCaseSubject)).toEqual([true, false, false]);
  });
});

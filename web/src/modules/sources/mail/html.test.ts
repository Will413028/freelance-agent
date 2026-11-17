import { describe, expect, it } from "vitest";
import { parseCake, SENDER as CAKE } from "./cake";
import { parse104, SENDER as JOBBANK104 } from "./jobbank104";
import { FULL_TIME, wordsIgnoreCase } from "./kind";
import { MailRejection } from "./reasons";
import { parseTasker, SENDER as TASKER } from "./tasker";

const reason = (f: () => unknown) => {
  try {
    f();
    return null;
  } catch (e) {
    if (e instanceof MailRejection) return e.reason;
    throw e;
  }
};
const deep = (inner: string) => "<b>".repeat(2_000) + inner;
const message = (sender: string, subject: string, body: string) => ({ id: "x", sender, subject, body, isHtml: true, receivedAt: "2026-09-26T03:00:00.000Z" });

describe("mail HTML", () => {
  it("rejects markup nested past MAX_DEPTH as html_too_deep in every parser, never a stack overflow", () => {
    const job = `<a href="https://www.cake.me/companies/example/jobs/backend-api">了解詳情</a>`;
    expect([
      reason(() => parseCake(message(CAKE, "您追蹤的 Example 刊登了一筆新職缺 - Backend", deep(job)))),
      reason(() => parseTasker(message(TASKER, "新案件【測試網站】", deep(job)))),
      reason(() => parse104(message(JOBBANK104, "測試09/26的配對日報，符合職缺1筆", deep(job)))),
    ]).toEqual(["html_too_deep", "html_too_deep", "html_too_deep"]);
  });
});

describe("kind words", () => {
  it("treats letters of every script as word characters, as the old Python patterns did", () => {
    const contract = wordsIgnoreCase(String.raw`兼職|\bcontract\b`);
    expect(["後端工程師Contract", "Contract 工程師", "工程師 contract"].map((t) => contract.test(t))).toEqual([false, true, true]);
    expect(["Full-time工程師", "Full-time 工程師", "全職"].map((t) => FULL_TIME.test(t))).toEqual([false, true, true]);
  });
});

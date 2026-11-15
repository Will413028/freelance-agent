import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { mailCursors, mailMessages, runSources } from "@/db/pg/schema";
import { listingBy, versionCount } from "@/modules/listings/public";
import { SourceError, sourceSettings, type MailSourceSettings } from "@/modules/sources/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { collectSource } from "./collect";
import { collectMail, MailConfigError } from "./collect-mail";
import { runDaily } from "./run-daily";
import { freshPg } from "../../tests/helpers/pg";

// Plan step 7a: a mail source into intake (old tests/mail-sources.test.ts and mail_sync cases, for the
// new system): each message once, a rejected one recorded with its reason and never undoing another,
// read failures carried to the daily run with their kind, an interrupted scan resumed.

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate listings, mail_messages, mail_cursors, runs cascade`));

const NOW = new Date("2026-11-16T07:00:00Z");
const ENV = { key: "re_test_key_123", inbox: "box@example.resend.app" };
const SENDER = "jobbank@ms1.104.com.tw";
const s = sourceSettings("jobbank104") as MailSourceSettings;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Mail = { n: number; from?: string; subject?: string; body?: string };
const card = (job: string) =>
  `<a href="https://www.104.com.tw/job/${job}">兼職 ${job} 工程師</a><a href="https://www.104.com.tw/company/c1">Example</a><p>台北市</p><a href="https://104app.onelink.me/zB8j/apply">我要應徵</a>`;
const digest = (...jobs: string[]) => `${jobs.map(card).join("")}<h2>適合你大展身手的工作</h2>`;
const subject = (count: number) => `你好11/16的配對日報，符合職缺${count}筆`;

/**
 * An inbox served as Resend would: newest first, `pageSize` per page, `after` continuing. `fail` maps a
 * URL fragment to an error thrown once. Requests are recorded.
 */
function inbox(mails: Mail[], opts: { pageSize?: number; fail?: Record<string, Error> } = {}) {
  const urls: string[] = [];
  const pageSize = opts.pageSize ?? 100;
  const fetcher: Fetcher = {
    get requests() { return urls.length; },
    get: async ({ url }) => {
      urls.push(url);
      for (const [frag, err] of Object.entries(opts.fail ?? {})) if (url.includes(frag)) { delete opts.fail![frag]; throw err; }
      const u = new URL(url);
      let data: unknown;
      if (u.pathname === "/emails/receiving") {
        const after = u.searchParams.get("after");
        const start = after === null ? 0 : mails.findIndex((m) => id(m.n) === after) + 1;
        const page = mails.slice(start, start + pageSize);
        data = { has_more: start + pageSize < mails.length, data: page.map((m) => ({ id: id(m.n), from: m.from ?? SENDER, subject: m.subject ?? subject(1) })) };
      } else {
        const m = mails.find((x) => u.pathname.endsWith(id(x.n)))!;
        data = { id: id(m.n), from: m.from ?? SENDER, to: [ENV.inbox], created_at: "2026-11-16T01:00:00.000Z", subject: m.subject ?? subject(1), html: m.body ?? digest(`j${m.n}`) };
      }
      return { status: 200, tier: "plain", body: new TextEncoder().encode(JSON.stringify(data)) };
    },
  };
  return { fetcher, urls, bodies: () => urls.filter((x) => !x.includes("?limit")).length };
}
const messages = async () => (await db.select().from(mailMessages)).map((r) => [r.messageId.slice(-2), r.status, r.reason]).sort();

describe("collectMail", () => {
  it("writes each new digest's listings once; a second run reads no body and adds no row (acceptance)", async () => {
    const box = inbox([{ n: 2, body: digest("a2", "b2"), subject: subject(2) }, { n: 1 }, { n: 3, from: "news@example.com" }]);
    const first = await collectMail(db, s, NOW, { fetcher: box.fetcher, env: ENV });
    expect([first.seen, first.examined, first.rejected, first.stored, first.truncated, first.intake.inserted]).toEqual([3, 2, 0, 3, false, 3]);
    expect(await messages()).toEqual([["01", "processed", null], ["02", "processed", null]]);
    const again = await collectMail(db, s, NOW, { fetcher: box.fetcher, env: ENV });
    expect([again.seen, again.examined, again.stored, box.bodies()]).toEqual([0, 0, 0, 2]);
    expect(await Promise.all(["a2", "b2", "j1"].map(async (x) => (await listingBy(db, "jobbank104", x))?.source))).toEqual(Array(3).fill("jobbank104"));
  });

  it("never reads a recorded message again, even when the scan position is lost", async () => {
    const box = inbox([{ n: 2, body: "<p>bad</p>" }, { n: 1 }]);
    await collectMail(db, s, NOW, { fetcher: box.fetcher, env: ENV });
    await db.execute(sql`truncate mail_cursors`);
    const again = await collectMail(db, s, NOW, { fetcher: box.fetcher, env: ENV });
    expect([again.seen, again.examined, box.bodies()]).toEqual([2, 0, 2]);
  });

  it("records a rejected digest with its reason and keeps the good one; most rejected fails the source", async () => {
    const box = inbox([{ n: 2, body: "<p>template changed</p>" }, { n: 1 }]);
    await expect(collectMail(db, s, NOW, { fetcher: box.fetcher, env: ENV })).resolves.toMatchObject({ rejected: 1, examined: 2, stored: 1 });
    expect(await messages()).toEqual([["01", "processed", null], ["02", "rejected", "104_incomplete_digest"]]);
    await db.execute(sql`truncate listings, mail_messages, mail_cursors cascade`);
    const worse = inbox([{ n: 3, body: "<p>x</p>" }, { n: 2, body: "<p>y</p>" }, { n: 1 }]);
    await expect(collectMail(db, s, NOW, { fetcher: worse.fetcher, env: ENV })).rejects.toThrow(/2 of 3 messages rejected/);
    expect(await listingBy(db, "jobbank104", "j1")).not.toBeNull();
  });

  it("keeps a contradicting digest of a known job as a version and marks the message content_changed", async () => {
    await collectMail(db, s, NOW, { fetcher: inbox([{ n: 1, body: digest("a") }]).fetcher, env: ENV });
    const changed = digest("a").replace("台北市", "新北市");
    await collectMail(db, s, NOW, { fetcher: inbox([{ n: 2, body: changed }, { n: 1, body: digest("a") }]).fetcher, env: ENV });
    expect(await messages()).toEqual([["01", "processed", null], ["02", "processed", "content_changed"]]);
    expect(await versionCount(db, (await listingBy(db, "jobbank104", "a"))!.id)).toBe(2);
  });

  it("only reads bodies from the source's sender with a digest subject", async () => {
    const box = inbox([{ n: 3, subject: "驗證通知" }, { n: 2, from: "jobbank@ms1.104.com.tw.evil.example" }, { n: 1 }]);
    await collectMail(db, s, NOW, { fetcher: box.fetcher, env: ENV });
    expect(box.urls.filter((u) => !u.includes("?limit"))).toEqual([`https://api.resend.com/emails/receiving/${id(1)}?html_format=cid`]);
    expect(await messages()).toEqual([["01", "processed", null]]);
  });

  it("stops at the body limit, saves its place, and the next run reads the rest and stops at the last scan's newest", async () => {
    const mails = [5, 4, 3, 2, 1].map((n) => ({ n }));
    const first = await collectMail(db, s, NOW, { fetcher: inbox(mails, { pageSize: 2 }).fetcher, env: ENV, limits: { maxPages: 20, maxMessages: 2 } });
    expect([first.examined, first.truncated]).toEqual([2, true]);
    const second = await collectMail(db, s, NOW, { fetcher: inbox(mails, { pageSize: 2 }).fetcher, env: ENV, limits: { maxPages: 20, maxMessages: 20 } });
    expect([second.examined, second.truncated]).toEqual([3, false]);
    expect((await db.select().from(mailCursors))[0]).toMatchObject({ cursor: id(5), after: null, head: null });
    const newer = await collectMail(db, s, NOW, { fetcher: inbox([{ n: 6 }, ...mails], { pageSize: 2 }).fetcher, env: ENV });
    expect([newer.seen, newer.examined, newer.truncated]).toEqual([1, 1, false]);
  });

  it("carries a read failure out with its position saved; the retry skips what was recorded", async () => {
    const mails = [{ n: 2 }, { n: 1 }];
    const box = inbox(mails, { fail: { [id(1)]: new FetchError("http_status", "HTTP 429", 429) } });
    await expect(collectMail(db, s, NOW, { fetcher: box.fetcher, env: ENV })).rejects.toMatchObject({ kind: "http_status", status: 429 });
    expect(await messages()).toEqual([["02", "processed", null]]);
    expect((await db.select().from(mailCursors))[0]).toMatchObject({ after: id(2), head: id(2) });
    const retry = await collectMail(db, s, NOW, { fetcher: box.fetcher, env: ENV });
    expect([retry.examined, retry.truncated]).toEqual([1, false]);
  });

  it("fails without a Resend key or inbox, and refuses an inbox outside Resend", async () => {
    const saved = { ...process.env };
    delete process.env.RESEND_API_KEY;
    try {
      await expect(collectMail(db, s, NOW, { fetcher: inbox([]).fetcher })).rejects.toBeInstanceOf(MailConfigError);
    } finally {
      process.env = saved;
    }
    await expect(collectMail(db, s, NOW, { fetcher: inbox([]).fetcher, env: { ...ENV, inbox: "me@gmail.com" } })).rejects.toBeInstanceOf(SourceError);
  });
});

describe("a mail source in the daily run", () => {
  it("records a Resend 429 with its kind and code after the retries (inventory defect 5)", async () => {
    const throttled: Fetcher = { requests: 0, get: async () => { throw new FetchError("http_status", "HTTP 429", 429); } };
    const out = await runDaily(db, { now: () => NOW, sleep: async () => {}, sources: [s], collect: (d, src, now) => collectSource(d, src, now, throttled, ENV) });
    expect(out.outcome).toBe("failed");
    expect((await db.select().from(runSources)).map((r) => [r.source, r.status, r.reason, r.error, r.counts])).toEqual([["jobbank104", "failed", "http_status", "http_429", { attempts: 3 }]]);
  });
});

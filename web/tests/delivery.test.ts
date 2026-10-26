import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildMessage, claimDigest, deliver, dispatch, finishDigest, getDailyRun, getDigest, messageSha256, type SmtpOpener } from "@/modules/notifications/public";
import { PyDateTime } from "@/platform/py/datetime";
import { PyDict } from "@/platform/py/value";
import type { SmtpClient } from "@/platform/smtp";
import { beginDailyRun, finishDaily } from "@/services/daily";
import { createDigest } from "@/services/digest";
import { finishStep } from "@/workflows/daily";
import { db, pool, resetSchema } from "./helpers/db";

// Plan step 10c: dispatch and deliver (notifications/scheduler.py, gmail_smtp.py) with a fake SMTP
// client; the outbox, its claim and its immutability trigger are the real Postgres ones.

const EMAIL = "owner@example.invalid";
const at = (h: number) => new PyDateTime(2026, 10, 24, h, 0, 0, 0, 0n);

type Fake = { opener: SmtpOpener; opened: number; sent: Uint8Array[]; closed: number };
function fakeSmtp(behaviour: { open?: () => void; send?: (raw: Uint8Array) => { accepted: string[]; rejected: string[] } } = {}): Fake {
  const fake: Fake = { opened: 0, sent: [], closed: 0, opener: async () => {
    fake.opened++;
    behaviour.open?.();
    const client: SmtpClient = {
      send: async (_from, _to, raw) => { fake.sent.push(raw); return behaviour.send ? behaviour.send(raw) : { accepted: [EMAIL], rejected: [] }; },
      close: () => { fake.closed++; },
    };
    return client;
  } };
  return fake;
}

const digest = () => createDigest(db, "2026-10-24", EMAIL, at(1));
const shaOf = async (id: string) => messageSha256(buildMessage((await getDigest(db, id)).snapshot, id, EMAIL));

beforeEach(async () => { await resetSchema(); process.env.DIGEST_RECIPIENT = EMAIL; });
afterAll(async () => { delete process.env.DIGEST_RECIPIENT; await pool.end(); });

describe("uncertain delivery is never retried", () => {
  it("records unknown when the sender throws, and a second delivery sends nothing", async () => {
    const intent = await digest();
    const failing = fakeSmtp({ send: () => { throw new Error("connection reset"); } });
    expect((await deliver(db, intent.id, EMAIL, await shaOf(intent.id), failing.opener)).status).toBe("unknown");
    expect(failing.sent).toHaveLength(1);
    const again = fakeSmtp();
    expect((await deliver(db, intent.id, EMAIL, await shaOf(intent.id), again.opener)).status).toBe("unknown");
    expect(again.opened).toBe(0);
    expect(again.sent).toHaveLength(0);
  });

  it("records unknown without a receipt", async () => {
    const intent = await digest();
    expect((await dispatch(db, intent.id, async () => null)).status).toBe("unknown");
    const refused = await digest().then(() => createDigest(db, "2026-10-25", EMAIL, at(1)));
    const fake = fakeSmtp({ send: () => ({ accepted: [], rejected: [EMAIL] }) });
    const row = await deliver(db, refused.id, EMAIL, await shaOf(refused.id), fake.opener);
    expect(row.status).toBe("unknown");
    expect(row.deliveryReceipt).toBeNull();
    const again = fakeSmtp();
    expect((await deliver(db, refused.id, EMAIL, await shaOf(refused.id), again.opener)).status).toBe("unknown");
    expect(again.sent).toHaveLength(0);
  });

  it("leaves a digest claimed by an interrupted process attempted", async () => {
    const intent = await digest();
    await claimDigest(db, intent.id); // the process died after the claim, before any outcome
    const fake = fakeSmtp();
    expect((await deliver(db, intent.id, EMAIL, await shaOf(intent.id), fake.opener)).status).toBe("attempted");
    expect(fake.opened).toBe(0);
    expect(fake.sent).toHaveLength(0);
  });

  it("only finishes an attempted digest", async () => {
    const intent = await digest();
    expect((await finishDigest(db, intent.id, "sent", "smtp-accepted:x")).status).toBe("pending");
  });

  it("never retries the step that sends", () => {
    expect(finishStep.maxRetries).toBe(0);
  });
});

describe("delivery checks", () => {
  it("sends the approved bytes once and records the receipt", async () => {
    const intent = await digest();
    const fake = fakeSmtp();
    const row = await deliver(db, intent.id, EMAIL, await shaOf(intent.id), fake.opener);
    expect(row.status).toBe("sent");
    expect(row.deliveryReceipt).toBe(`smtp-accepted:${intent.id}`);
    expect(fake.sent).toHaveLength(1);
    expect(messageSha256(fake.sent[0])).toBe(await shaOf(intent.id));
    expect(fake.closed).toBe(1);
  });

  it("refuses a preview hash that does not match, before connecting", async () => {
    const intent = await digest();
    const fake = fakeSmtp();
    await expect(deliver(db, intent.id, EMAIL, "0".repeat(64), fake.opener)).rejects.toThrow("Preview hash mismatch");
    expect(fake.opened).toBe(0);
    expect((await getDigest(db, intent.id)).status).toBe("pending");
  });

  it("leaves the digest pending when login fails", async () => {
    const intent = await digest();
    const fake = fakeSmtp({ open: () => { throw new Error("auth"); } });
    await expect(deliver(db, intent.id, EMAIL, await shaOf(intent.id), fake.opener)).rejects.toThrow();
    expect((await getDigest(db, intent.id)).status).toBe("pending");
  });

  it("refuses to send when the snapshot changed after the preview", async () => {
    const intent = await digest();
    const sha = await shaOf(intent.id);
    // The immutability trigger makes this impossible in production; the sender check is the second line.
    const fake = fakeSmtp({ open: () => {} });
    const opener: SmtpOpener = async (email) => {
      await pool.query("alter table digest_outbox disable trigger digest_immutable");
      await pool.query("update digest_outbox set snapshot = replace(snapshot, '\"unseen_count\": 0', '\"unseen_count\": 1') where id = $1", [intent.id]);
      await pool.query("alter table digest_outbox enable trigger digest_immutable");
      return fake.opener(email);
    };
    expect((await deliver(db, intent.id, EMAIL, sha, opener)).status).toBe("unknown");
    expect(fake.sent).toHaveLength(0);
  });
});

describe("daily run with delivery", () => {
  const run = async (open: SmtpOpener | null, details: Record<string, never> | null = {}) => {
    const begin = await beginDailyRun(db, at(1));
    return finishDaily(db, begin.localDate, begin.startedAt!, details, open);
  };

  it("does not claim when delivery is not configured", async () => {
    expect(await run(null)).toEqual({ status: "complete", delivery: "not_configured" });
    const result = (await getDailyRun(db, "2026-10-24", EMAIL))!.result as PyDict;
    expect(result.has("delivery_error")).toBe(false);
    expect(result.at("delivery_status")).toBe("pending");
  });

  it("sends the day's digest and records it on the run", async () => {
    const fake = fakeSmtp();
    expect(await run(fake.opener)).toEqual({ status: "complete", delivery: "sent" });
    expect(fake.sent).toHaveLength(1);
    const result = (await getDailyRun(db, "2026-10-24", EMAIL))!.result as PyDict;
    expect(result.at("delivery_status")).toBe("sent");
  });

  it("fails the run but keeps the digest pending when login fails", async () => {
    const fake = fakeSmtp({ open: () => { throw new Error("auth"); } });
    expect(await run(fake.opener)).toEqual({ status: "failed", delivery: "send_preflight_failed" });
    const result = (await getDailyRun(db, "2026-10-24", EMAIL))!.result as PyDict;
    expect(result.at("delivery_error")).toBe("send_preflight_failed");
    expect((await getDigest(db, result.str("intent_id"))).status).toBe("pending");
  });

  it("does not send a reused snapshot", async () => {
    await digest(); // built by an earlier run whose daily_runs row is gone
    const fake = fakeSmtp();
    expect(await run(fake.opener, null)).toEqual({ status: "failed", delivery: "existing_snapshot_requires_review" });
    expect(fake.opened).toBe(0);
    const result = (await getDailyRun(db, "2026-10-24", EMAIL))!.result as PyDict;
    expect(result.at("delivery_error")).toBe("existing_snapshot_requires_review");
  });
});

describe("digest message", () => {
  it("is the same bytes for the same snapshot, addressed only to the account", async () => {
    const intent = await digest();
    const a = buildMessage(intent.snapshot, intent.id, EMAIL), b = buildMessage(intent.snapshot, intent.id, "Owner@Example.invalid");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const text = Buffer.from(a).toString("latin1");
    expect(text).not.toMatch(/(?<!\r)\n/);
    expect(text).toContain(`From: ${EMAIL}\r\nTo: ${EMAIL}\r\n`);
    expect(text).toContain("Date: Sat, 24 Oct 2026 01:00:00 +0000\r\n");
    const subject = /Subject: =\?utf-8\?b\?([^?]+)\?=/.exec(text)![1];
    expect(Buffer.from(subject, "base64").toString("utf8")).toBe("接案摘要 · 2026-10-24");
    expect(() => buildMessage(intent.snapshot, intent.id, "someone@example.invalid")).toThrow("verified account");
    expect(() => buildMessage(intent.snapshot, intent.id, "not an address")).toThrow("verified account");
  });

  it("carries the text and the HTML of the digest", async () => {
    const intent = await digest();
    const parts = Buffer.from(buildMessage(intent.snapshot, intent.id, EMAIL)).toString("latin1").split(/--digest_[0-9a-f]{64}/);
    const body = (part: string) => Buffer.from(part.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(parts).toHaveLength(4); // preamble, text, html, closing "--"
    expect(body(parts[1])).toContain("目前沒有可列出的候選");
    expect(body(parts[2])).toContain("案件條件仍需人工確認；本信不代表已投遞。");
  });
});

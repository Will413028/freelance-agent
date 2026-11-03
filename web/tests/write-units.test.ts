import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { dbOver, usageOf } from "@/db/client";
import { D1Client, D1Error, type D1Statement } from "@/db/d1/client";
import { GUARD_SQL } from "@/db/d1/guard";
import { opportunities } from "@/db/schema";
import { DAILY_WRITE, writeUnit } from "@/db/unit";
import { ingestResendBatch, ingestSource, opportunityId, runSource, type Listing } from "@/modules/collection/public";
import { getDailyRun } from "@/modules/notifications/public";
import { allRecords } from "@/modules/legacy/public";
import { uiBusy } from "@/platform/errors";
import { PyDateTime } from "@/platform/py/datetime";
import { encode } from "@/platform/py/json";
import { asDict, PyDict } from "@/platform/py/value";
import { beginDailyRun, finishDaily } from "@/services/daily";
import { track } from "@/services/discovery";
import { client, db, intercepting, leased, losingResponse, query, recording, resetSchema } from "./helpers/db";
import { job } from "./helpers/jobs";

// Plan step 4e2b: write units under the writer lease (D20-B). A unit reads with the lease, computes
// with its own unsent writes visible, and writes in batches guarded by the lease's holder and token.
const now = new PyDateTime(2026, 10, 26, 1, 0, 0, 0, 0n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEY = opportunityId("tasker", "c1");
const listing = (externalId: string, receipt: string, title = "AI agent workflow"): Listing =>
  [job({ source: "tasker", external_id: externalId, title }), receipt];
const intake = (items: Listing[], d = db) => ingestSource(d, "tasker", now, items, () => true, "ok");
const leaseRow = sql`update writer_lease set expires_at = expires_at`;
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
};

beforeEach(async () => { await resetSchema(); process.env.DIGEST_RECIPIENT = "owner@example.invalid"; });
afterAll(() => { delete process.env.DIGEST_RECIPIENT; });

describe("intake units", () => {
  it("reads with the lease in one request and writes with it in one more", async () => {
    const before = client.counters.requests;
    await intake([listing("c1", "r1")]);
    expect(client.counters.requests - before).toBe(2);
    // Nothing changed: the release is the only write.
    const again = client.counters.requests;
    await intake([listing("c1", "r1")]);
    expect(client.counters.requests - again).toBe(2);
    expect(await query("select holder from writer_lease")).toEqual([{ holder: null }]);
  });

  it("lets a later listing of the same batch see the record an earlier one created", async () => {
    const first = listing("dup", "r1", "First title"), second = listing("dup", "r2", "Second title");
    await intake([first, second]);
    const [item] = await allRecords(db);
    expect([item.dict("job").req("title"), item.req("version")]).toEqual(["Second title", 2n]);
    const id = opportunityId("tasker", "dup");
    expect(await query("select receipt_id, opportunity_id from source_receipts order by receipt_id"))
      .toEqual([{ receipt_id: "r1", opportunity_id: id }, { receipt_id: "r2", opportunity_id: id }]);
  });

  it("splits a large unit into guarded batches, each record with its receipt, health last", async () => {
    const items = Array.from({ length: 1300 }, (_, i) => listing(`s${i}`, `r${i}`));
    const rec = recording();
    await intake(items, rec.db);
    const writes = rec.batches.filter((b) => b[0].sql === GUARD_SQL);
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.every((b) => b.length <= 75)).toBe(true);
    const rows = (b: { sql: string; params: unknown[] }[], table: string, perRow: number) =>
      b.filter((s) => s.sql.startsWith(`insert into "${table}"`)).reduce((n, s) => n + s.params.length / perRow, 0);
    for (const b of writes) expect(rows(b, "source_receipts", 3)).toBe(rows(b, "opportunities", 4));
    expect(writes.map((b) => rows(b, "source_health", 2))).toEqual([...writes.slice(1).map(() => 0), 1]);
    expect(await query("select count(*) n from opportunities")).toEqual([{ n: 1300 }]);
    expect(await query("select count(*) n from source_receipts")).toEqual([{ n: 1300 }]);
  });
});

describe("the writer lease", () => {
  it("refuses a write to a leased table that does not start with the guard", async () => {
    await expect(query("update opportunities set item = item")).rejects.toThrow("must start with the writer lease guard");
    await query("update source_health set status = status");
    // DDL that destroys or reshapes a leased table's rows needs the lease too (plan step 4e3).
    await expect(query("drop table if exists opportunities")).rejects.toThrow("must start with the writer lease guard");
    await expect(query("alter table clients add column x text")).rejects.toThrow("must start with the writer lease guard");
  });

  it("blocks the batch of a holder whose lease expired and was taken, then runs the unit again from fresh reads", async () => {
    await intake([listing("c1", "r1", "Old")]);
    const [skipped] = await allRecords(db);
    skipped.update({ review_status: "skipped", skip_reason: "scope" });
    await leased("update opportunities set item = ?1 where id = ?2", [encode(skipped), KEY]);
    let writes = 0;
    const slow = intercepting(async (statements) => {
      if (statements[0] !== GUARD_SQL || writes++ > 0) return;
      // Intake's lease runs out before its write arrives; a page request takes the lease and un-skips the record.
      await query("update writer_lease set expires_at = 0");
      await track(db, KEY, 0n, { feedback: "interested" }, now);
    });
    await intake([listing("c1", "r2", "New")], slow.db);
    expect(writes).toBe(2);
    const [item] = await allRecords(db);
    // Both changes: intake's new content on top of the page request's un-skip (version 1 → 2 → 3).
    expect([item.dict("job").req("title"), item.req("review_status"), item.req("version")]).toEqual(["New", "draft", 3n]);
    expect(JSON.parse((await query("select state from opportunity_tracking"))[0].state).feedback).toBe("interested");
  });

  it("does not accept the holder's token again once the lease was released", async () => {
    const rec = recording();
    await writeUnit(rec.db, DAILY_WRITE, [], (_, writes) => writes.statement(rec.db.run(sql`update source_receipts set received_at = received_at`)));
    const guard = rec.batches.flat().find((s) => s.sql === GUARD_SQL)! as D1Statement;
    await expect(client.batch([guard, { sql: "update source_receipts set received_at = received_at", params: [] }])).rejects.toThrow("guard failed");
  });

  it("makes a page request wait while intake holds the lease, then keeps both writes", async () => {
    await intake([listing("c1", "r1", "Old")]);
    const holding = gate(), done = gate();
    const slow = intercepting(async (statements) => {
      if (statements[0] !== GUARD_SQL) return;
      holding.open();
      await done.opened;
    });
    const running = intake([listing("c1", "r2", "New")], slow.db);
    await holding.opened;
    const waitedBefore = client.counters.leaseWaitMs;
    const page = track(db, KEY, 0n, { feedback: "interested", note: "看過" }, now);
    await sleep(300);
    done.open();
    await Promise.all([running, page]);
    expect(client.counters.leaseWaitMs - waitedBefore).toBeGreaterThan(0);
    const [item] = await allRecords(db);
    expect(item.dict("job").req("title")).toBe("New");
    expect(await query("select revision from tracking_events")).toEqual([{ revision: 1 }]);
  });

  it("answers a page request with 409 when the lease stays taken past its wait", async () => {
    const holding = gate(), done = gate();
    const slow = intercepting(async (statements) => {
      if (statements[0] !== GUARD_SQL) return;
      holding.open();
      await done.opened;
    });
    const running = writeUnit(slow.db, DAILY_WRITE, [], (_, writes) => writes.statement(slow.db.run(leaseRow)));
    await holding.opened;
    const timeouts = client.counters.leaseTimeouts;
    await expect(writeUnit(db, { waitMs: 200, busy: uiBusy }, [], () => null)).rejects.toThrow("系統忙碌，請稍後再試");
    expect(client.counters.leaseTimeouts - timeouts).toBe(1);
    done.open();
    await running;
  });

  it("answers 409 to reload when the lease is lost before every write", async () => {
    const stolen = intercepting(async (statements) => {
      if (statements[0] === GUARD_SQL) await query("update writer_lease set holder = 'other', token = token + 1, expires_at = 0");
    });
    const unit = writeUnit(stolen.db, { waitMs: 200, busy: uiBusy }, [], (_, writes) => writes.statement(stolen.db.run(sql`update source_receipts set received_at = received_at`)));
    await expect(unit).rejects.toThrow("資料已更新，請重新載入");
  });

  it("waits out the lease of a holder that crashed, without failing", async () => {
    await query("insert into writer_lease (id, holder, token, expires_at) values (1, 'crashed', 7, unixepoch())");
    const waitedBefore = client.counters.leaseWaitMs;
    await intake([listing("c1", "r1")]);
    expect(client.counters.leaseWaitMs - waitedBefore).toBeGreaterThan(0);
    expect(await query("select holder, token from writer_lease")).toEqual([{ holder: null, token: 8 }]);
  });

  it("prunes write attempts older than 7 days in the batches that add them", async () => {
    await query("insert into write_attempts (attempt_id, at) values ('old', unixepoch() - 8 * 86400), ('recent', unixepoch() - 86400)");
    await intake([listing("c1", "r1")]);
    const ids = (await query<{ attempt_id: string }>("select attempt_id from write_attempts")).map((r) => r.attempt_id);
    expect(ids).toContain("recent");
    expect(ids).not.toContain("old");
    expect(ids).toHaveLength(2);
  });
});

describe("unit limits", () => {
  it("refuses to split a unit that is not intake, writing nothing", async () => {
    const unit = writeUnit(db, DAILY_WRITE, [], (_, writes) => {
      for (let i = 0; i < 2000; i++) writes.put(opportunities, { kind: "insert" }, `o${i}`, { id: `o${i}`, source: "tasker", externalId: `o${i}`, item: "{}" }, `o${i}`);
    });
    await expect(unit).rejects.toThrow("only intake may split");
    expect(await query("select holder from writer_lease")).toEqual([{ holder: null }]);
    expect(await query("select count(*) n from opportunities")).toEqual([{ n: 0 }]);
    const raw = writeUnit(db, DAILY_WRITE, [], (_, writes) => {
      for (let i = 0; i < 80; i++) writes.statement(db.run(sql`update opportunities set item = item where id = ${String(i)}`));
    });
    await expect(raw).rejects.toThrow("exceeds one request");
    // Few raw statements, but large ones (the projection's bulk settings updates): their bytes count too.
    const large = writeUnit(db, DAILY_WRITE, [], (_, writes) => {
      for (let i = 0; i < 50; i++) writes.statement(db.run(sql`update opportunities set item = item where id = ${String(i)}`), 90_000);
    });
    await expect(large).rejects.toThrow(/write batch of \d+ bytes exceeds one request/);
  });

  it("refuses an asynchronous computation, which could wait on the network while holding the lease", async () => {
    await expect(writeUnit(db, DAILY_WRITE, [], (async () => null) as never)).rejects.toThrow("computes synchronously");
    expect(await query("select holder from writer_lease")).toEqual([{ holder: null }]);
  });

  it("inserts a record it read as absent with a plain INSERT, and saves one it read with an upsert", async () => {
    const rec = recording();
    await intake([listing("c1", "r1")], rec.db);
    await intake([listing("c1", "r2", "Changed")], rec.db);
    const opportunities = rec.batches.flat().filter((s) => s.sql.startsWith('insert into "opportunities"')).map((s) => s.sql.includes("on conflict"));
    expect(opportunities).toEqual([false, true]);
  });

  it("records a step that failed on storage with the storage reason, not the source's", async () => {
    // D1 answers 429 to everything: the ADR's "any 429" trigger must be readable from the run.
    const limited = dbOver(new D1Client({ batch: async () => { throw new D1Error("rate_limited", false, "429"); } }));
    const runner = () => ingestSource(limited, "freelancer", now, [], () => true, "ok").then(() => PyDict.of({ status: "ok" }));
    expect(await runSource(db, "freelancer", runner, "freelancer_failed")).toEqual({ status: "failed", reason: "storage_rate_limited" });
    // Counted where it happened, whichever caller caught it.
    expect(usageOf(limited).d1_errors).toEqual({ rate_limited: 1 });
  });
});

describe("a write whose response was lost", () => {
  it("records a tracking change once and reports it saved", async () => {
    await intake([listing("c1", "r1")]);
    const lossy = losingResponse((statements) => statements[0] === GUARD_SQL);
    const item = await track(lossy.db, KEY, 0n, { feedback: "interested" }, now);
    expect(lossy.fired()).toBe(true);
    expect(item.dict("tracking").req("revision")).toBe(1n);
    expect(await query("select revision from tracking_events")).toEqual([{ revision: 1 }]);
  });

  it("counts a new mail content version once", async () => {
    const mail = (title: string, receipt: string) => job({ source: "tasker", external_id: "m1", title, receipt_id: receipt });
    await ingestResendBatch(db, [mail("First", "m-1")], now);
    const lossy = losingResponse((statements) => statements[0] === GUARD_SQL);
    expect((await ingestResendBatch(lossy.db, [mail("Second", "m-2")], now)).contentVersions).toBe(1);
    expect(lossy.fired()).toBe(true);
    expect(await query("select count(*) n from mail_content_versions")).toEqual([{ n: 2 }]);
  });
});

describe("daily run usage", () => {
  it("records D1 requests, rows written and lease waits of the whole run at the top of the result", async () => {
    const step = recording().db; // a client of its own, as each workflow step has
    const begin = await beginDailyRun(step, now);
    const earlier = { d1_requests: 5, d1_rows_written: 7, lease_wait_ms: 3, lease_timeouts: 1, lease_lost: 0, d1_errors: { rate_limited: 1 }, lost_steps: 1 };
    await finishDaily(step, begin.localDate, begin.startedAt!, {}, null, earlier);
    const result = asDict((await getDailyRun(db, begin.localDate, "owner@example.invalid"))!.result);
    expect(result.req("d1_requests")).toBeGreaterThan(5n);
    expect(result.req("d1_rows_written")).toBeGreaterThanOrEqual(7n);
    expect(result.req("lease_wait_ms")).toBeGreaterThanOrEqual(3n);
    expect([result.req("lease_timeouts"), result.req("lost_steps"), encode(result.req("d1_errors"))]).toEqual([1n, 1n, '{"rate_limited": 1}']);
    expect(result.dict("source_details").has("d1_requests")).toBe(false);
  });
});

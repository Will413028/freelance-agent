import { beforeEach, describe, expect, it } from "vitest";
import { announced, backfillNovelty, claimDailyRun, claimDigest, findDigest, finishDigest, getDailyRun, insertDigest } from "@/modules/notifications/public";
import { encode } from "@/platform/py/json";
import { PyDateTime } from "@/platform/py/datetime";
import { PyDict } from "@/platform/py/value";
import { createDigest } from "@/services/digest";
import { list } from "./helpers/reference";
import { client, db, losingResponse, query, resetSchema } from "./helpers/db";

// Plan step 4e2a: reads and single statements on D1. No transactions exist, so what used to be a
// read transaction is one batch, and a lost response is answered by the statement's own semantics.
const at = (h: number) => new PyDateTime(2026, 10, 24, h, 0, 0, 0, 0n);
const EMAIL = "owner@example.invalid";

beforeEach(resetSchema);

describe("reads on D1", () => {
  it("reads a list in two requests: the ranking over the projection, then the ranked rows (plan step 10e2)", async () => {
    const before = client.counters.requests;
    await list(db, at(1));
    expect(client.counters.requests - before).toBe(2);
  });

  it("reads the existing digest and the sources with the ranking before building a digest", async () => {
    const before = client.counters.requests;
    await createDigest(db, "2026-10-24", EMAIL, at(1));
    // Ranking, ranked rows and one write: with no candidates there are no announced pairs to look up.
    expect(client.counters.requests - before).toBe(3);
    const again = client.counters.requests;
    await createDigest(db, "2026-10-24", EMAIL, at(2));
    expect(client.counters.requests - again).toBe(2);
  });
});

describe("lists longer than D1's 100 parameters", () => {
  const snapshot = (n: number, prefix: string) => encode(PyDict.of({ items: Array.from({ length: n }, (_, i) =>
    PyDict.of({ id: `${prefix}${i}`, fingerprint: `f${i}`, novelty_keys: [[`k:${prefix}${i}`, `f${i}`]] })) }));

  it("looks up announced pairs for any number of keys in one statement", async () => {
    await query("insert into digest_outbox (id, local_date, recipient, snapshot, status, delivery_receipt) values ('d', '2026-10-01', ?1, ?2, 'sent', 'r')", [EMAIL, snapshot(150, "a")]);
    await backfillNovelty(db, await query<{ id: string; snapshot: string }>("select id, snapshot from digest_outbox"));
    const keys = Array.from({ length: 250 }, (_, i) => `k:a${i}`);
    expect((await announced(db, EMAIL, keys)).size).toBe(150);
  });

  it("backfills many digests in a few requests", async () => {
    for (let d = 0; d < 60; d++) {
      await query("insert into digest_outbox (id, local_date, recipient, snapshot) values (?1, ?2, ?3, ?4)", [`d${d}`, `2026-08-${d}`, EMAIL, snapshot(2, `d${d}-`)]);
    }
    const digests = await query<{ id: string; snapshot: string }>("select id, snapshot from digest_outbox");
    const before = client.counters.requests;
    expect(await backfillNovelty(db, digests)).toBe(120);
    expect(client.counters.requests - before).toBe(2);
  });
});

describe("single statements after a lost response", () => {
  it("recognizes its own daily claim when the response was lost after commit", async () => {
    const lossy = losingResponse((sql) => sql[0].startsWith("insert into \"daily_runs\""));
    expect(await claimDailyRun(lossy.db, "2026-10-24", EMAIL, at(1))).toBe(true);
    expect(lossy.fired()).toBe(true);
    expect(await claimDailyRun(db, "2026-10-24", EMAIL, at(2))).toBe(false);
    expect((await getDailyRun(db, "2026-10-24", EMAIL))!.startedAt).toBe(at(1).isoformat());
  });

  it("returns the committed digest once when the write's response was lost", async () => {
    const lossy = losingResponse((sql) => sql[0].startsWith("insert into \"digest_outbox\""));
    const digest = await createDigest(lossy.db, "2026-10-24", EMAIL, at(1));
    expect(lossy.fired()).toBe(true);
    expect(await query("select id from digest_outbox")).toEqual([{ id: digest.id }]);
  });

  it("returns the day's stored digest when another run stored it between read and write", async () => {
    const first = await createDigest(db, "2026-10-24", EMAIL, at(1));
    const second = await insertDigest(db, [], PyDict.of({}), "2026-10-24", EMAIL, at(2));
    expect(second.id).toBe(first.id);
    expect(await query("select count(*) n from digest_outbox")).toEqual([{ n: 1 }]);
  });

  it("records the delivery outcome when the finishing response was lost", async () => {
    const digest = await createDigest(db, "2026-10-24", EMAIL, at(1));
    await claimDigest(db, digest.id);
    const lossy = losingResponse((sql) => sql[0].startsWith("update \"digest_outbox\""));
    expect((await finishDigest(lossy.db, digest.id, "sent", "smtp-accepted:x")).status).toBe("sent");
    expect(lossy.fired()).toBe(true);
    expect((await findDigest(db, "2026-10-24", EMAIL))!.deliveryReceipt).toBe("smtp-accepted:x");
  });
});

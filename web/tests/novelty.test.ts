import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ingest } from "@/modules/collection/public";
import { groupItems, isCandidate, publicItem } from "@/modules/discovery/public";
import { backfillNoveltyIn, checkNoveltyIn, claimDigest, findDigest, finishDigest, noveltyRows } from "@/modules/notifications/public";
import { PyDateTime } from "@/platform/py/datetime";
import { encode } from "@/platform/py/json";
import { asDict, asList, PyDict } from "@/platform/py/value";
import { createDigest } from "@/services/digest";
import { list } from "@/services/discovery";
import { db, pool, resetSchema } from "./helpers/db";
import { job } from "./helpers/jobs";

// Plan step 10b2 (D15): which candidates an earlier digest already announced is read from the
// digest_novelty ledger, written with each snapshot from its items and never changed, instead of
// rescanning every stored snapshot. The golden digest scenario proves the selection matches Python.
const owner = "owner@example.invalid";
const day = (d: number) => new PyDateTime(2026, 10, d, 1, 0, 0, 0, 0n);
const ledger = async () => (await pool.query("select digest_id, key, fingerprint from digest_novelty order by 1, 2, 3")).rows;
const itemIds = (snapshot: PyDict) => asList(snapshot.req("items")).map((i) => asDict(i).str("id"));
const stored = async () => (await pool.query("select id, snapshot from digest_outbox order by id")).rows as { id: string; snapshot: string }[];

beforeEach(resetSchema);
afterAll(async () => { await pool.end(); });

async function deliver(localDate: string, outcome: "sent" | "attempted" | "unknown") {
  const intent = (await findDigest(db, localDate, owner))!;
  await claimDigest(db, intent.id);
  if (outcome !== "attempted") await finishDigest(db, intent.id, outcome, outcome === "sent" ? "receipt" : null);
}

describe("notified ledger", () => {
  it("stores the snapshot's novelty pairs in the same write and nothing else", async () => {
    await ingest(db, job({ external_id: "1" }), null, day(1));
    await ingest(db, job({ external_id: "2", title: "Data pipeline", url: "https://www.freelancer.com/projects/other-2" }), null, day(1));
    const digest = await createDigest(db, "2026-10-01", owner, day(1));
    expect(itemIds(digest.snapshot)).toHaveLength(2);
    const want = noveltyRows(digest.snapshot).map(([key, fingerprint]) => ({ digest_id: digest.id, key, fingerprint }));
    expect(want.length).toBeGreaterThan(2);
    const order = (r: { key: string; fingerprint: string }) => [r.key, r.fingerprint];
    expect(await ledger()).toEqual(want.sort((a, b) => Buffer.compare(Buffer.from(order(a).join("\0")), Buffer.from(order(b).join("\0")))));
    expect(await checkNoveltyIn(db)).toEqual({ digests: 1, rows: want.length, missing: 0, extra: 0 });
  });

  for (const outcome of ["sent", "attempted", "unknown"] as const) {
    it(`suppresses what a ${outcome} digest announced`, async () => {
      await ingest(db, job({ external_id: "1" }), null, day(1));
      await createDigest(db, "2026-10-01", owner, day(1));
      await deliver("2026-10-01", outcome);
      expect(itemIds((await createDigest(db, "2026-10-02", owner, day(2))).snapshot)).toEqual([]);
      // Another recipient's deliveries never suppress this one's.
      expect(itemIds((await createDigest(db, "2026-10-02", "other@example.invalid", day(2))).snapshot)).toHaveLength(1);
    });
  }

  it("never suppresses what a still pending digest announced", async () => {
    await ingest(db, job({ external_id: "1" }), null, day(1));
    await createDigest(db, "2026-10-01", owner, day(1));
    expect(itemIds((await createDigest(db, "2026-10-02", owner, day(2))).snapshot)).toHaveLength(1);
  });

  it("backfills snapshots stored before the ledger, deriving keys for items without novelty_keys", async () => {
    await ingest(db, job({ external_id: "1" }), null, day(1));
    const candidate = groupItems(await list(db, day(1))).filter(isCandidate)[0];
    // A digest Python stored before snapshots carried novelty_keys: public fields and the fingerprint.
    const legacy = PyDict.of({ items: [publicItem(candidate).update({ fingerprint: candidate.req("fingerprint") })], recipient: owner, local_date: "2026-09-01" });
    await pool.query("insert into digest_outbox (id, local_date, recipient, snapshot, status, delivery_receipt) values ('old', '2026-09-01', $1, $2, 'sent', 'r')",
      [owner, encode(legacy)]);
    expect(await checkNoveltyIn(db)).toMatchObject({ digests: 1, rows: 0, extra: 0 });
    expect(await backfillNoveltyIn(db, await stored())).toBeGreaterThan(1);
    await expect(backfillNoveltyIn(db, await stored())).rejects.toThrow();
    expect(await checkNoveltyIn(db)).toMatchObject({ missing: 0, extra: 0 });
    expect(itemIds((await createDigest(db, "2026-10-01", owner, day(1))).snapshot)).toEqual([]);
  });

  it("suppresses a listing whose content an announced opportunity no longer in the table carried", async () => {
    // Today's list groups listings that share an identity key and content, so the group's ids cover
    // them; only an announced item whose opportunity row is gone is matched by identity key alone.
    await ingest(db, job({ external_id: "1" }), null, day(1));
    const candidate = groupItems(await list(db, day(1))).filter(isCandidate)[0];
    const gone = publicItem(candidate).update({ id: "gone-1", member_ids: ["gone-1"], fingerprint: "old" });
    gone.delete("members");
    await pool.query("insert into digest_outbox (id, local_date, recipient, snapshot, status, delivery_receipt) values ('old', '2026-09-01', $1, $2, 'sent', 'r')",
      [owner, encode(PyDict.of({ items: [gone] }))]);
    await backfillNoveltyIn(db, await stored());
    expect(itemIds((await createDigest(db, "2026-10-01", owner, day(1))).snapshot)).toEqual([]);
  });

  it("reports ledger rows that differ from the snapshots", async () => {
    await ingest(db, job({ external_id: "1" }), null, day(1));
    const digest = await createDigest(db, "2026-10-01", owner, day(1));
    // The trigger forbids deletes; a rebuild that lost a row is simulated with the trigger disabled.
    await pool.query("alter table digest_novelty disable trigger digest_novelty_immutable");
    await pool.query("delete from digest_novelty where ctid = (select min(ctid) from digest_novelty)");
    await pool.query("alter table digest_novelty enable trigger digest_novelty_immutable");
    await pool.query("insert into digest_novelty values ($1, 'stray', 'x')", [digest.id]);
    expect(await checkNoveltyIn(db)).toMatchObject({ missing: 1, extra: 1 });
  });

  it("refuses to change or remove a ledger row", async () => {
    await ingest(db, job({ external_id: "1" }), null, day(1));
    await createDigest(db, "2026-10-01", owner, day(1));
    await expect(pool.query("update digest_novelty set fingerprint = 'x'")).rejects.toThrow("Digest novelty is immutable");
    await expect(pool.query("delete from digest_novelty")).rejects.toThrow("Digest novelty is immutable");
    await expect(pool.query("truncate digest_novelty")).rejects.toThrow("Digest novelty is immutable");
  });
});

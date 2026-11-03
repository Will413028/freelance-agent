import { beforeEach, describe, expect, it } from "vitest";
import { ingestResendBatch, ingestSource, opportunityId, type Listing } from "@/modules/collection/public";
import { novelty, noveltyOf, readSettings } from "@/modules/discovery/public";
import { PyDateTime } from "@/platform/py/datetime";
import { encode } from "@/platform/py/json";
import { PyDict } from "@/platform/py/value";
import { list, listPage, rebuildProjectionInPlace, replaceSettings, track } from "@/services/discovery";
import { db, leased, query, resetSchema } from "./helpers/db";
import { job } from "./helpers/jobs";

// Plan step 10e1 (D16, D18 P1): the discovery projection. The reference is list_in over the raw rows
// (evaluate, recommendation, is_candidate at `now`); the projection read ranks in SQL and assembles
// only the page, and must give the same items in the same order at every `now`.

const at = (iso: string) => {
  const [d, t] = iso.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm, rest] = t.replace("Z", "").split(":");
  const [ss, us = "0"] = rest.split(".");
  return new PyDateTime(y, m, day, Number(hh), Number(mm), Number(ss), Number(us.padEnd(6, "0")), 0n);
};
const ingestNow = at("2026-11-01T00:00:00Z");
const key = (externalId: string) => opportunityId("tasker", externalId);
const listing = (externalId: string, changes: Record<string, unknown> = {}): Listing =>
  [job({ source: "tasker", external_id: externalId, ...changes }), null];
const intake = (items: Listing[]) => ingestSource(db, "tasker", ingestNow, items, () => true, "ok");
const mail = (externalId: string, receipt: string, changes: Record<string, unknown>) =>
  job({ source: "tasker", external_id: externalId, receipt_id: receipt, ...changes });

/** Instants around the deadlines and publication ages of the fixture (all UTC). */
const NOWS = [
  "2026-11-10T03:59:59.999999Z", // 1 µs before the aware deadline (12:00 +08:00); published-2 days minus 1 µs
  "2026-11-10T04:00:00Z", // the aware deadline itself: expired; exactly 2 and 7 days after two publications
  "2026-11-10T04:00:00.000001Z", // just past those ages
  "2026-11-10T23:59:59.999999Z", // the last instant of the date-only deadline's day in UTC
  "2026-11-11T00:00:00Z", // the next UTC day: the date-only deadline has passed
  "2026-12-31T00:00:00Z",
].map(at);

async function seed() {
  await intake([
    listing("aware", { deadline: "2026-11-10T12:00:00+08:00" }),
    listing("dated", { deadline: "2026-11-10" }),
    listing("open", { deadline: null }),
    listing("recent", { published_at: "2026-11-08T04:00:00Z" }),
    listing("week", { published_at: "2026-11-03T04:00:00Z", weekly_hours: 40n }),
    listing("design", { title: "Logo design", description: "Brand refresh" }),
    listing("closed", { listing_closed: true, deadline: null }),
    listing("liked"),
    listing("skipped"),
    listing("applied"),
    listing("staged"),
  ]);
  // A content version that differs from its record: only the version is possible, only it has a
  // deadline, and its own publication gives it a different score than the record.
  await ingestResendBatch(db, [mail("closed", "m-1", { listing_closed: true, deadline: null })], ingestNow);
  await ingestResendBatch(db, [mail("closed", "m-2", { listing_closed: false, deadline: "2026-11-10", title: "AI agent workflow v2", published_at: "2026-11-08T04:00:00Z" })], ingestNow);
  await track(db, key("liked"), 0n, { feedback: "interested" }, ingestNow);
  await track(db, key("skipped"), 0n, { feedback: "skipped" }, ingestNow);
  await track(db, key("staged"), 0n, { stage: "applied", evidence: "confirmation-1" }, ingestNow);
  await leased("insert into manual_applications values ('a1','t','c',null,'2026-10-01','applied',null,'',1,'c','u',null,'q1','{}')");
  await leased("insert into manual_application_opportunities values ('a1', ?1)", [key("applied")]);
}

const page = (now: PyDateTime, offset = 0, limit = 1000) => listPage(db, now, { offset, limit });
const same = async (now: PyDateTime) => expect(encode(await page(now))).toBe(encode(await list(db, now)));

/** The projection as stored, ordered. */
const stored = async () => ({
  items: await query("select * from discovery_items order by opportunity_id"),
  versions: await query("select * from discovery_versions order by opportunity_id, fingerprint"),
});

/** The projection rebuilt in place from the current rows (scripts/rebuild-projection.ts; the import and the replay use the same row functions). */
async function rebuilt() {
  const before = await stored();
  await rebuildProjectionInPlace(db, 0);
  return { before, after: await stored() };
}

beforeEach(resetSchema);

describe("discovery projection (plan step 10e1)", () => {
  it("ranks like list_in at every now around deadlines, day boundaries and publication ages", async () => {
    await seed();
    for (const now of NOWS) await same(now);
    // The fixture exercises what it is meant to: expiry, the version-only deadline, and the exclusions.
    const candidates = async (now: PyDateTime) => (await page(now)).map((i): [string, string] => [i.str("id"), i.dict("evaluation").str("status")]);
    const before = new Map(await candidates(NOWS[0])), after = new Map(await candidates(NOWS[4]));
    expect(before.get(key("aware"))).not.toBe("excluded");
    expect(after.get(key("aware"))).toBe("excluded");
    expect(before.get(key("dated"))).not.toBe("excluded");
    expect(after.get(key("dated"))).toBe("excluded");
  });

  it("pages are slices of the full ranking", async () => {
    await seed();
    const now = NOWS[2];
    const all = (await list(db, now)).map((i) => i.str("id"));
    for (const [offset, limit] of [[0, 3], [3, 3], [9, 5]]) {
      expect((await page(now, offset, limit)).map((i) => i.str("id"))).toEqual(all.slice(offset, offset + limit));
    }
  });

  it("stores the novelty pairs list_in's items announce", async () => {
    await seed();
    const items = await list(db, NOWS[0]);
    const { items: rows, versions } = await stored();
    for (const item of items) {
      const row = rows.find((r) => r.opportunity_id === item.str("id"))!;
      const fps = versions.filter((v) => v.opportunity_id === item.str("id")).map((v) => String(v.fingerprint));
      const expected: string[][] = [...novelty(item).values()].map((pair) => [...pair]);
      expect(noveltyOf(String(row.novelty), item.str("id"), fps)).toEqual(expected.sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)));
    }
  });

  it("maintains incrementally what a rebuild produces: intake, versions, feedback, settings", async () => {
    await seed();
    // From empty (right after the migration): the in-place rebuild fills it and the read serves it.
    await leased("delete from discovery_versions");
    await leased("delete from discovery_items");
    await rebuildProjectionInPlace(db, 0);
    await same(NOWS[0]);
    let { before, after } = await rebuilt();
    expect(before).toEqual(after);
    expect(after.versions).toHaveLength(2);

    // A settings change rewrites every row's settings columns in its own unit.
    const current = await readSettings(db);
    await replaceSettings(db, current.revision, new PyDict(current.settings).update({ max_weekly_hours: 50n, categories: ["AI agent", "後端／API"] }));
    for (const now of NOWS) await same(now);
    ({ before, after } = await rebuilt());
    expect(before).toEqual(after);
    expect(new Set(after.items.map((r) => r.settings_revision))).toEqual(new Set([1]));

    // A new content version of a record that had none, and a record that changes.
    await ingestResendBatch(db, [mail("open", "m-3", { deadline: null })], ingestNow);
    await ingestResendBatch(db, [mail("open", "m-4", { deadline: "2026-11-10T00:00:00Z", description: "A new brief for the agent build." })], ingestNow);
    await intake([listing("week", { published_at: "2026-11-03T04:00:00Z", weekly_hours: 20n })]);
    await track(db, key("liked"), 1n, { feedback: "skipped" }, ingestNow);
    for (const now of NOWS) await same(now);
    ({ before, after } = await rebuilt());
    expect(before).toEqual(after);
    expect(after.versions).toHaveLength(4);
  });

  it("refuses a projection that is out of date instead of ranking from it", async () => {
    await seed();
    await leased("update discovery_items set settings_revision = 7 where opportunity_id = ?1", [key("open")]);
    await expect(page(NOWS[0])).rejects.toThrow("discovery projection out of date");
    await resetSchema();
    await seed();
    await leased("delete from discovery_versions where fingerprint = (select min(fingerprint) from discovery_versions)");
    await expect(page(NOWS[0])).rejects.toThrow("discovery projection out of date");
  });

  it("refuses a row whose stored columns disagree with the record", async () => {
    await seed();
    await leased("update discovery_items set base_tenths = base_tenths + 10 where opportunity_id = ?1", [key("open")]);
    await expect(page(NOWS[0])).rejects.toThrow("discovery projection disagrees");
  });

  it("reads at a UTC now only", async () => {
    await seed();
    await expect(page(new PyDateTime(2026, 11, 10, 12, 0, 0, 0, 8n * 3_600_000_000n))).rejects.toThrow("UTC now");
  });
});

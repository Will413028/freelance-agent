import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ingestSource, type Listing } from "@/modules/collection/public";
import { groupItems, readSettings } from "@/modules/discovery/public";
import { PyDateTime } from "@/platform/py/datetime";
import { PyDict } from "@/platform/py/value";
import { listPage, replaceSettings } from "@/services/discovery";
import { referenceList as list } from "./helpers/reference";
import { client, db, query, resetSchema } from "./helpers/db";
import { job } from "./helpers/jobs";

// Cost guard at production scale (production had 2,226 opportunities on 2026-10-23; this uses
// 2,500): the CPU-bound grouping and the projection's page read and settings rewrite, so a port
// that is correct but quadratic fails in CI instead of on Vercel's 300 s step limit. The digest's
// selection and build were measured here until plan step 10f removed the digest (D22).
const OPPORTUNITIES = 2_500;
const now = new PyDateTime(2026, 10, 26, 1, 0, 0, 0, 0n);
const hex = (n: number) => randomBytes(n).toString("hex");
let items: PyDict[] = [];

const timed = <T>(fn: () => T): [T, number] => {
  const started = Date.now();
  const value = fn();
  return [value, Date.now() - started];
};

beforeAll(async () => {
  await resetSchema();
  const bySource = new Map<string, Listing[]>([["freelancer", []], ["tasker", []]]);
  for (let i = 0; i < OPPORTUNITIES; i++) {
    // Each block of five listings shares a URL and title across two sources; one in five carries a different budget.
    const block = i - (i % 5), source = i % 2 ? "tasker" : "freelancer";
    bySource.get(source)!.push([job({ external_id: `s${i}`, url: `https://www.freelancer.com/projects/scale-${block}`, title: `AI agent workflow ${block}`,
      description: `Build an agent API ${i} ${hex(8)}`, source, ...(i % 5 === 4 ? { budget_max: 9000n } : {}) }), null]);
  }
  // 1,250 new records per source: more than one write batch, so this also loads through the split.
  for (const [source, listed] of bySource) {
    await ingestSource(db, source, now, listed, () => true, null);
  }
  items = await list(db, now);
}, 600_000);

describe("grouping at production scale", () => {
  it("groups production-sized listings within 10 s", () => {
    const [groups, ms] = timed(() => groupItems(items));
    process.stderr.write(`groupItems: ${items.length} items → ${groups.length} groups in ${ms} ms\n`);
    expect(groups).toHaveLength(items.length); // D18 A3: one listing per group
    expect(ms).toBeLessThan(10_000);
  });
});

describe("discovery projection at production scale (plan step 10e1)", () => {
  it("serves a page ranked in SQL as list_in ranks it", async () => {
    const started = Date.now();
    const page = await listPage(db, now, { offset: 0, limit: 50 });
    process.stderr.write(`listPage: 50 of ${items.length} in ${Date.now() - started} ms\n`);
    expect(page.map((item) => item.str("id"))).toEqual(items.slice(0, 50).map((item) => item.str("id")));
  });

  it("rewrites every row's settings columns in one write request (plan step 4e2b handoff (2))", async () => {
    const current = await readSettings(db), before = client.counters.requests;
    // A unit other than intake refuses to write past one request, so success here means it fit.
    await replaceSettings(db, current.revision, new PyDict(current.settings).update({ max_weekly_hours: 5n }));
    expect(client.counters.requests - before).toBe(2);
    expect(await query("select count(*) as n from discovery_items where settings_revision = ?1", [Number(current.revision) + 1])).toEqual([{ n: OPPORTUNITIES }]);
    const after = await list(db, now);
    expect((await listPage(db, now, { offset: 100, limit: 50 })).map((item) => item.str("id"))).toEqual(after.slice(100, 150).map((item) => item.str("id")));
  }, 120_000);
});

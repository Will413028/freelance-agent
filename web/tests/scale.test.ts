import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTransaction } from "@/db/client";
import { ingestIn } from "@/modules/collection/public";
import { groupItems } from "@/modules/discovery/public";
import { selectUnseen } from "@/modules/notifications/outbox";
import { PyDateTime } from "@/platform/py/datetime";
import { encode } from "@/platform/py/json";
import { PyDict } from "@/platform/py/value";
import { createDigest } from "@/services/digest";
import { list } from "@/services/discovery";
import { db, pool, resetSchema } from "./helpers/db";
import { job } from "./helpers/jobs";

// Cost guard at production scale. On 2026-10-25 createDigestIn ran past 10 minutes on the
// production copy: unseen() rebuilt the seen-id set for every candidate and groupItems
// re-normalized both jobs' fields for every member pair (Python does the same, in C). The golden
// tests prove the output on small data; this bounds the pure, CPU-bound phases on
// production-sized data, so a port that is correct but quadratic fails in CI instead of on
// Vercel's 300 s step limit. Database time is left out of the tight bounds because it is noisy.
// Scale: production had 2,226 opportunities and 37 digests on 2026-10-23; this uses 2,500 and 60.
// Measured on an M-series Mac: grouping about 1.4 s, selection about 0.7 s (with the
// per-candidate rebuild the selection took over 20 s).
const OPPORTUNITIES = 2_500, PRIOR_DIGESTS = 60, ITEMS_PER_DIGEST = 100, KEYS_PER_ITEM = 6;
const now = new PyDateTime(2026, 10, 26, 1, 0, 0, 0, 0n);
const hex = (n: number) => randomBytes(n).toString("hex");
let items: PyDict[] = [];
let prior: string[] = [];

const timed = <T>(fn: () => T): [T, number] => {
  const started = Date.now();
  const value = fn();
  return [value, Date.now() - started];
};

beforeAll(async () => {
  await resetSchema();
  await writeTransaction(db, async (tx) => {
    for (let i = 0; i < OPPORTUNITIES; i++) {
      // Each block of five listings shares a URL and title across two sources, so groups form; one
      // in five carries a different budget, so some merges are refused after the pair checks.
      const block = i - (i % 5);
      await ingestIn(tx, job({ external_id: `s${i}`, url: `https://www.freelancer.com/projects/scale-${block}`, title: `AI agent workflow ${block}`,
        description: `Build an agent API ${i} ${hex(8)}`, source: i % 2 ? "tasker" : "freelancer", ...(i % 5 === 4 ? { budget_max: 9000n } : {}) }), null, now);
    }
  });
  items = await list(db, now);
  // Prior digests only feed novelty suppression, which reads their items' novelty_keys.
  prior = Array.from({ length: PRIOR_DIGESTS }, () => encode(PyDict.of({
    items: Array.from({ length: ITEMS_PER_DIGEST }, () => PyDict.of({ novelty_keys: Array.from({ length: KEYS_PER_ITEM }, () => [hex(32), hex(32)]) })),
  })));
}, 600_000);
afterAll(async () => { await pool.end(); });

describe("digest at production scale", () => {
  it("groups production-sized listings within 10 s", () => {
    const [groups, ms] = timed(() => groupItems(items));
    process.stderr.write(`groupItems: ${items.length} items → ${groups.length} groups in ${ms} ms\n`);
    expect(ms).toBeLessThan(10_000);
  });

  it("selects unseen candidates against 60 days of history within 5 s", () => {
    const [{ candidates, fresh }, ms] = timed(() => selectUnseen(items, prior));
    process.stderr.write(`selectUnseen: ${candidates.length} candidates, ${fresh.length} unseen in ${ms} ms\n`);
    expect(fresh.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(5_000);
  });

  it("builds the whole digest well inside the 300 s step limit", async () => {
    for (const [n, text] of prior.entries()) {
      await pool.query("insert into digest_outbox (id, local_date, recipient, snapshot, status, delivery_receipt) values ($1, $2, 'owner@example.invalid', $3, 'sent', 'r')",
        [`prior-${n}`, `prior-${n}`, text]);
    }
    const [digest, ms] = await (async () => { const s = Date.now(); const d = await createDigest(db, "2026-10-26", "owner@example.invalid", now); return [d, Date.now() - s] as const; })();
    process.stderr.write(`createDigest: ${ms} ms\n`);
    expect(digest.snapshot.req("unseen_count")).toBeGreaterThan(0n);
    expect(ms).toBeLessThan(60_000);
  }, 120_000);
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existingSourceIds, ingest, setSourceHealth, sourceBatch, sourcesIn } from "@/modules/collection/public";
import { readSettings, replaceSettings, settingsDict } from "@/modules/discovery/public";
import { groupItems, publicItem } from "@/modules/discovery/rules";
import { feedback, list, memberVersions, track } from "@/services/discovery";
import { identityHash } from "@/platform/py/json";
import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { encode } from "@/platform/py/json";
import { asDict, asList, PyDict, pySorted, type PyValue } from "@/platform/py/value";
import { db, pool, resetSchema } from "./helpers/db";
import { attemptAsync, fixture, untag, type Expect, type Tagged } from "./helpers/golden";

// Replays the store scenarios that web/tests/fixtures/gen_golden.py ran against the Python
// SQLiteStore: every step's result and the final stored rows must match byte for byte.
type Op = { op: string; [k: string]: any };
type Scenario = { ops: Op[]; results: Expect<string>[]; tables: Record<string, unknown[][]> };
const golden = fixture<{ now: string; scenarios: Record<string, Scenario> }>("golden.json");

const TABLES: [string, string, string][] = [
  ["opportunities", "id,source,external_id,item", "id"],
  ["proposal_revisions", "opportunity_id,version,proposal,fingerprint", "opportunity_id,version"],
  ["source_receipts", "source,receipt_id,opportunity_id", "source,receipt_id"],
  ["source_health", "source,status", "source"],
  ["opportunity_tracking", "opportunity_id,state", "opportunity_id"],
  ["tracking_events", "id,opportunity_id,revision,state,created_at", "id"],
  ["discovery_settings", "id,revision,settings", "id"],
];

const refId = (ref: string | string[]) => (typeof ref === "string" ? ref : identityHash(ref));
const groupOf = async (key: string, now: PyDateTime) =>
  groupItems(await list(db, now)).find((g) => asList(g.req("member_ids")).includes(key))!;

async function replay(s: Scenario) {
  let now = fromisoformat(golden.now);
  const captured = new Map<string, PyDict>();
  const results: Expect<string>[] = [];
  for (const op of s.ops) {
    const u = (k: string) => untag(op[k] as Tagged);
    const run: Record<string, () => Promise<PyValue>> = {
      ingest: async () => ingest(db, u("job"), op.receipt_id ?? null, now),
      batch: () => sourceBatch(db, op.source, now, async (batch) => {
        for (const [j, receipt] of op.items as [Tagged, string][]) await batch.ingest(untag(j), receipt);
        if (op.finish) await batch.finish(op.finish);
        return pySorted(await batch.existingIds());
      }),
      set_preferences: async () => settingsDict(await replaceSettings(db, u("revision"), u("settings"))),
      track: async () => {
        const kw = op.kw ? Object.fromEntries(asDict(u("kw"))) : {};
        return track(db, refId(op.ref), u("revision"), kw, now);
      },
      capture: async () => {
        const versions = memberVersions(await groupOf(refId(op.ref), now));
        captured.set(refId(op.ref), versions);
        return versions;
      },
      feedback: async () => {
        const key = refId(op.ref);
        const g = await groupOf(key, now);
        const versions = op.versions === "captured" ? captured.get(key)! : g ? memberVersions(g) : new PyDict();
        return feedback(db, key, versions, op.feedback, now);
      },
      health: async () => { await setSourceHealth(db, op.source, op.status); return null; },
      clock: async () => { now = fromisoformat(op.now); return null; },
      list: async () => list(db, now),
      groups: async () => groupItems(await list(db, now)),
      public: async () => groupItems(await list(db, now)).map(publicItem),
      preferences: async () => settingsDict(await readSettings(db)),
      sources: async () => sourcesIn(db),
      existing: async () => pySorted(await existingSourceIds(db, op.source)),
    };
    results.push(await attemptAsync(async () => encode(await run[op.op]())));
  }
  const tables: Record<string, unknown[][]> = {};
  for (const [table, columns, order] of TABLES) {
    const { rows } = await pool.query({ text: `select ${columns} from ${table} order by ${order}`, rowMode: "array" });
    tables[table] = rows;
  }
  return { results, tables };
}

beforeEach(resetSchema);
afterAll(async () => { await pool.end(); });

describe("store scenarios replay the Python store byte for byte", () => {
  for (const [name, scenario] of Object.entries(golden.scenarios)) {
    it(name, async () => {
      const got = await replay(scenario);
      const steps = scenario.ops.map((op, n) => ({ n, op: op.op, want: scenario.results[n], got: got.results[n] }))
        .filter((s) => JSON.stringify(s.want) !== JSON.stringify(s.got));
      expect(steps).toEqual([]);
      expect(got.tables).toEqual(scenario.tables);
    });
  }
});

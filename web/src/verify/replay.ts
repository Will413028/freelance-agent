import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "@/db/schema";
import { fromisoformat } from "@/platform/py/datetime";
import { createDigestIn } from "@/services/digest";
import { loadCopy } from "@/ops/converge";
import { openSqlite, pgColumns, readSqliteRows, rowText } from "@/ops/rows";
import { TABLES } from "@/ops/tables";

// Same-start digest replay (plan step 10b). The live comparator cannot compare digests: the two
// runs fetch sources minutes apart, so their candidates differ. Here the TS digest code runs on
// exactly the data Python built its digest from — the after-run copy without that day's digest —
// at Python's generated_at, and the two snapshots must be byte-identical. Everything happens in
// one shadow-database transaction on temporary tables that is always rolled back, so the shadow
// keeps the TS run.

export type ReplayReport = {
  day: string;
  /**
   * null when nothing can be concluded: Python has no digest that day, or Will changed a user table
   * (feedback, settings, applications) between the 08:30 copy and the after-run copy, which the
   * replay would read although Python's digest may have been built before it.
   */
  equal: boolean | null;
  /** User-owned tables that differ between the two copies (why the day is inconclusive). */
  userChanges: string[];
  python: { items: number; bytes: number } | null;
  ts: { items: number; bytes: number } | null;
  /** First differing UTF-16 offset of the snapshot text, and the opportunity ids only one side lists. */
  firstDifference: number | null;
  onlyPython: string[];
  onlyTs: string[];
};

const ids = (snapshot: string) => (JSON.parse(snapshot).items as { id: string }[]).map((i) => i.id);

/** Tables Will writes through the UI/API (owner "user") whose rows differ between the two copies. */
async function userChanges(startCopy: string, pythonCopy: string, pool: Pool): Promise<string[]> {
  const start = openSqlite(startCopy), after = openSqlite(pythonCopy);
  try {
    const changed: string[] = [];
    for (const spec of TABLES.filter((t) => t.owner === "user")) {
      const columns = await pgColumns(pool, spec.name);
      const text = (lite: typeof start) => readSqliteRows(lite, spec, columns).map(rowText).join("\n");
      if (text(start) !== text(after)) changed.push(spec.name);
    }
    return changed;
  } finally {
    start.close();
    after.close();
  }
}

export async function replayDigest(paths: { start: string; python: string }, pool: Pool, day: string): Promise<ReplayReport> {
  const pythonCopy = paths.python;
  const changes = await userChanges(paths.start, pythonCopy, pool);
  const lite = openSqlite(pythonCopy);
  try {
    const rows = lite.prepare("select recipient, snapshot from digest_outbox where local_date = ?").all(day) as { recipient: string; snapshot: string }[];
    if (rows.length > 1) throw new Error(`digest_outbox ${day}: ${rows.length} Python digests, expected at most one`);
    const empty: ReplayReport = { day, equal: null, userChanges: changes, python: null, ts: null, firstDifference: null, onlyPython: [], onlyTs: [] };
    if (!rows.length || changes.length) return empty;
    const [{ recipient, snapshot: python }] = rows;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout = '5s'");
      // Temporary tables shadow the public ones for every unqualified name in this session (pg_temp
      // is searched first), so the product code reads and writes only the copy. LIKE copies columns,
      // defaults, checks, keys and identity, not foreign keys or triggers; the public tables, their
      // rows and their retention triggers are never touched.
      for (const t of TABLES) await client.query(`create temporary table "${t.name}" (like public."${t.name}" including all) on commit drop`);
      await loadCopy(client, lite, (table, columns, row) => {
        if (table !== "digest_outbox") return true;
        const at = columns.findIndex((c) => c.name === "local_date");
        const cell = row[at];
        return !(cell !== null && "s" in cell && cell.s === day);
      });
      await createDigestIn(drizzle(client, { schema }), day, recipient, fromisoformat(JSON.parse(python).generated_at));
      // The stored text, which is what Python's row holds, not a re-encoding of the returned value.
      const text = (await client.query<{ snapshot: string }>("select snapshot from digest_outbox where local_date = $1 and recipient = $2", [day, recipient])).rows[0].snapshot;
      let first = 0;
      while (first < python.length && first < text.length && python[first] === text[first]) first++;
      const equal = python === text;
      const py = ids(python), mine = ids(text);
      return {
        day, equal, userChanges: changes, python: { items: py.length, bytes: Buffer.byteLength(python) }, ts: { items: mine.length, bytes: Buffer.byteLength(text) },
        firstDifference: equal ? null : first, onlyPython: py.filter((i) => !mine.includes(i)), onlyTs: mine.filter((i) => !py.includes(i)),
      };
    } finally {
      await client.query("rollback");
      client.release();
    }
  } finally {
    lite.close();
  }
}

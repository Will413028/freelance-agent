import { dbOver } from "@/db/client";
import { D1Client } from "@/db/d1/client";
import { localTransport } from "@/db/d1/local";
import { migrateD1 } from "@/db/migrate";
import { withLease } from "@/db/unit";
import { checkTableSet, copiedDigests, loadCopy } from "@/ops/import";
import { openSqlite, readSqliteRows, rowText, sqliteColumns } from "@/ops/rows";
import { TABLES } from "@/ops/tables";
import { fromisoformat } from "@/platform/py/datetime";
import { createDigest, rebuildNovelty } from "@/services/digest";

// Same-start digest replay (plan step 10b; on the local D1 stand-in since step 4e3). The TS digest
// code runs on exactly the data Python built its digest from — the after-run copy without that
// day's digest — at Python's generated_at, and the two snapshots must be byte-identical. It runs on
// a fresh in-memory stand-in with the current migrations, so it touches neither D1 nor the copy.

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
function userChanges(startCopy: string, pythonCopy: string): string[] {
  const start = openSqlite(startCopy), after = openSqlite(pythonCopy);
  try {
    return TABLES.filter((t) => t.owner === "user").filter((spec) => {
      const text = (lite: typeof start) => readSqliteRows(lite, spec, sqliteColumns(lite, spec.name)).map(rowText).join("\n");
      return text(start) !== text(after);
    }).map((spec) => spec.name);
  } finally {
    start.close();
    after.close();
  }
}

export async function replayDigest(paths: { start: string; python: string }, day: string): Promise<ReplayReport> {
  const changes = userChanges(paths.start, paths.python);
  const lite = openSqlite(paths.python);
  const stand = localTransport(":memory:");
  try {
    checkTableSet(lite);
    const rows = lite.prepare("select recipient, snapshot from digest_outbox where local_date = ?").all(day) as { recipient: string; snapshot: string }[];
    if (rows.length > 1) throw new Error(`digest_outbox ${day}: ${rows.length} Python digests, expected at most one`);
    const empty: ReplayReport = { day, equal: null, userChanges: changes, python: null, ts: null, firstDifference: null, onlyPython: [], onlyTs: [] };
    if (!rows.length || changes.length) return empty;
    const [{ recipient, snapshot: python }] = rows;
    const db = dbOver(new D1Client(stand));
    await migrateD1(db);
    await withLease(db, 0, (send) => loadCopy(db, lite, send, (table, columns, row) => {
      if (table !== "digest_outbox") return true;
      const cell = row[columns.findIndex((c) => c.name === "local_date")];
      return !(cell !== null && "s" in cell && cell.s === day);
    }));
    // The ledger the TS digest selects with, derived from the same earlier digests Python scanned.
    await rebuildNovelty(db, copiedDigests(lite, day));
    await createDigest(db, day, recipient, fromisoformat(JSON.parse(python).generated_at));
    // The stored text, which is what Python's row holds, not a re-encoding of the returned value.
    const [stored] = await stand.batch([{ sql: "select snapshot from digest_outbox where local_date = ? and recipient = ?", params: [day, recipient] }]);
    const text = String(stored.rows[0][0]);
    let first = 0;
    while (first < python.length && first < text.length && python[first] === text[first]) first++;
    const equal = python === text;
    const py = ids(python), mine = ids(text);
    return {
      day, equal, userChanges: changes, python: { items: py.length, bytes: Buffer.byteLength(python) }, ts: { items: mine.length, bytes: Buffer.byteLength(text) },
      firstDifference: equal ? null : first, onlyPython: py.filter((i) => !mine.includes(i)), onlyTs: mine.filter((i) => !py.includes(i)),
    };
  } finally {
    stand.close();
    lite.close();
  }
}

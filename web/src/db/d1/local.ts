// Local stand-in for D1 (tests and the VM's after job; plan step 4e). It must refuse what D1 refuses,
// or a test passes here and the code breaks on D1: transaction statements, more than 100 bound
// parameters, SQL over 100 KB. A batch is atomic, as on D1; the savepoint that makes it so is
// internal to the stand-in and never reachable from product code. Not imported by the app.
import { DatabaseSync } from "node:sqlite";
import { D1Error, type D1Result, type D1Transport } from "./client";

const TRANSACTION_STATEMENT = /^\s*(begin|commit|end|rollback|savepoint|release)\b/i;
const MAX_PARAMS = 100;
const MAX_SQL_BYTES = 100_000;

function check(sql: string, params: unknown[]) {
  if (TRANSACTION_STATEMENT.test(sql)) {
    throw new D1Error("rejected", false, "To execute a transaction, please use the state.storage.transaction() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements");
  }
  if (params.length > MAX_PARAMS) throw new D1Error("rejected", false, `too many SQL variables (${params.length} > ${MAX_PARAMS})`);
  if (Buffer.byteLength(sql) > MAX_SQL_BYTES) throw new D1Error("rejected", false, `statement too long (${Buffer.byteLength(sql)} bytes)`);
}

/** Integers come back as bigint so that values above 2^53 are rounded exactly as D1's JSON does. */
const asJson = (v: unknown) => (typeof v === "bigint" ? Number(v) : v instanceof Uint8Array ? Array.from(v) : v);

export function localTransport(path: string): D1Transport & { close(): void } {
  const db = new DatabaseSync(path);
  return {
    async batch(statements) {
      for (const s of statements) check(s.sql, s.params);
      db.exec("savepoint d1_batch");
      try {
        const results: D1Result[] = statements.map(({ sql, params }) => {
          const stmt = db.prepare(sql);
          stmt.setReadBigInts(true);
          const columns = stmt.columns().map((c) => c.name);
          if (columns.length > 0) {
            stmt.setReturnArrays(true);
            const rows = (stmt.all(...params) as unknown as unknown[][]).map((row) => row.map(asJson));
            return { columns, rows, changes: 0, rowsWritten: 0, rowsRead: rows.length };
          }
          const run = stmt.run(...params);
          const changes = Number(run.changes);
          // An approximation: D1 also counts index rows. Quota numbers come from real D1 (CI, reports).
          return { columns, rows: [], changes, rowsWritten: changes, rowsRead: 0 };
        });
        db.exec("release d1_batch");
        return results;
      } catch (e) {
        db.exec("rollback to d1_batch");
        db.exec("release d1_batch");
        if (e instanceof D1Error) throw e;
        const message = e instanceof Error ? e.message : String(e);
        const code = (e as { errcode?: number }).errcode;
        // SQLite primary result code 19 is SQLITE_CONSTRAINT; D1 reports it as "…: SQLITE_CONSTRAINT".
        if (code !== undefined && (code & 0xff) === 19) throw new D1Error("constraint", false, `${message}: SQLITE_CONSTRAINT`);
        throw new D1Error("rejected", false, message);
      }
    },
    close: () => db.close(),
  };
}

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { CopyError, fingerprint, openSqlite, pgColumns, readPgRows, readSqliteRows, sqliteColumns, sqliteTables, type Row } from "./rows";
import { IDENTITY_COLUMNS, TABLES } from "./tables";

// Convergence script v1 (plan step 4c): empty the shadow database and load a consistent SQLite copy
// of production into it, unchanged. Rows keep their primary keys, so a rerun of the same copy gives
// the same database; an interrupted run rolls back its load and is simply run again.

export type TableReport = { rows: number; sha256: string };
export type ConvergeReport = { ok: boolean; tables: Record<string, { source: TableReport; target: TableReport }> };

const PARAM_LIMIT = 60_000; // Postgres allows 65535 bind parameters per statement

export async function resetShadowSchema(pool: Pool, migrationsFolder: string) {
  await pool.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public");
  await migrate(drizzle(pool), { migrationsFolder });
}

export async function converge(sqlitePath: string, pool: Pool, migrationsFolder: string): Promise<ConvergeReport> {
  const lite = openSqlite(sqlitePath);
  try {
    const present = sqliteTables(lite), expected = TABLES.map((t) => t.name).sort();
    if (present.join() !== expected.join()) {
      throw new CopyError(`table set differs from the converge list: missing ${expected.filter((t) => !present.includes(t)).join(" ") || "-"}, ` +
        `unexpected ${present.filter((t) => !expected.includes(t)).join(" ") || "-"}`);
    }
    await resetShadowSchema(pool, migrationsFolder);
    const source = new Map<string, Row[]>();
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const spec of TABLES) {
        const columns = await pgColumns(client, spec.name);
        const liteNames = sqliteColumns(lite, spec.name);
        if (liteNames.join() !== columns.map((c) => c.name).join()) throw new CopyError(`${spec.name}: column list differs between SQLite and Postgres`);
        const rows = readSqliteRows(lite, spec, columns);
        source.set(spec.name, rows);
        const per = Math.max(1, Math.floor(PARAM_LIMIT / columns.length));
        const names = columns.map((c) => `"${c.name}"`).join(",");
        // OVERRIDING SYSTEM VALUE keeps copied identity values (tracking_events.id).
        const overriding = IDENTITY_COLUMNS[spec.name] ? " overriding system value" : "";
        for (let at = 0; at < rows.length; at += per) {
          const chunk = rows.slice(at, at + per);
          const values = chunk.map((_, r) => "(" + columns.map((__, c) => `$${r * columns.length + c + 1}`).join(",") + ")").join(",");
          await client.query(`insert into "${spec.name}" (${names})${overriding} values ${values}`,
            chunk.flat().map((cell) => (cell === null ? null : "i" in cell ? cell.i : cell.s)));
        }
        const identity = IDENTITY_COLUMNS[spec.name];
        if (identity) {
          await client.query(`select setval(pg_get_serial_sequence('"${spec.name}"', '${identity}'), coalesce(max("${identity}"), 0) + 1, false) from "${spec.name}"`);
        }
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
    return report(source, pool);
  } finally {
    lite.close();
  }
}

/** Per-table counts and content fingerprints of what was read and what Postgres now holds. */
async function report(source: Map<string, Row[]>, pool: Pool): Promise<ConvergeReport> {
  const tables: ConvergeReport["tables"] = {};
  let ok = true;
  for (const spec of TABLES) {
    const columns = await pgColumns(pool, spec.name);
    const rows = source.get(spec.name) ?? [];
    const target = await readPgRows(pool, spec, columns);
    tables[spec.name] = { source: { rows: rows.length, sha256: fingerprint(rows) }, target: { rows: target.length, sha256: fingerprint(target) } };
    ok &&= tables[spec.name].source.sha256 === tables[spec.name].target.sha256;
  }
  return { ok, tables };
}

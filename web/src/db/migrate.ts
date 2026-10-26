import path from "node:path";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import { clientOf, type Db } from "./client";
import { DAILY_WRITE, MAX_LEASED_STATEMENTS, withLease } from "./unit";

// The only way migrations reach D1 (plan step 4e3; drizzle-kit only generates them): every pending
// migration and its journal row in one request, so a failure leaves nothing half applied
// (drizzle-kit's own d1-http migrate sends statement by statement, plan step 4e2a). On a database
// that already has the writer lease the request goes behind its guard, like any write to the leased
// tables: a migration that rebuilds or alters one of them must not interleave with a daily run.
// Only the very first migration of an empty database, which creates writer_lease, runs without it.

export const MIGRATIONS = path.resolve(import.meta.dirname, "../../drizzle");

export async function migrateD1(db: Db, migrationsFolder = MIGRATIONS, waitMs = DAILY_WRITE.waitMs) {
  const client = clientOf(db);
  const [lease] = await client.batch([{ sql: "select 1 from sqlite_master where type = 'table' and name = 'writer_lease'", params: [] }]);
  await migrate(db, async (queries) => {
    if (queries.length === 0) return;
    const statements = queries.map((sql) => ({ sql, params: [] }));
    if (lease.rows.length === 0) {
      await client.batch(statements);
      return;
    }
    if (statements.length > MAX_LEASED_STATEMENTS) throw new Error(`pending migrations need ${statements.length} statements; split them to apply each in one request`);
    await withLease(db, waitMs, (send) => send(statements));
  }, { migrationsFolder });
}

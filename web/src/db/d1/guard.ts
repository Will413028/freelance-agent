// The structural half of the writer lease (D20-B correctness condition 1): a batch that writes a
// leased table must begin with the lease guard, or the client refuses to send it. Every product
// write therefore either holds the lease or fails loudly, instead of each path remembering to guard.
import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../schema";

/** The first statement of a leased write batch: aborts the batch unless the lease still names (holder, token). */
export const GUARD_SQL = "insert into guard (ok) select 0 where not exists (select 1 from writer_lease where id = 1 and holder = ? and token = ?)";

/**
 * D1-only bookkeeping (plan step 4e): guard aborts a batch whose precondition failed, write_attempts
 * records batches whose response may have been lost, writer_lease is the writer lease (D20-B). Not
 * product data: never copied, compared, written back, or dropped by the import.
 */
export const D1_ONLY_TABLES = ["guard", "write_attempts", "writer_lease"];

/**
 * Tables written without the lease: those of the single conditional statements of plan step 4e
 * category 1 (daily runs, the digest and its ledger, source health, mail cursors and records), and
 * the D1-only bookkeeping. Every other product table is leased, including tables added later.
 */
const SINGLE_STATEMENT_TABLES = ["daily_runs", "digest_outbox", "digest_novelty", "source_health", "mail_ingestion", "mail_sync_state"];
const UNLEASED = new Set([...SINGLE_STATEMENT_TABLES, ...D1_ONLY_TABLES]);

export const LEASED = new Set(Object.values(schema).filter((v) => is(v, SQLiteTable)).map((t) => getTableName(t as SQLiteTable)).filter((n) => !UNLEASED.has(n)));

const WRITE = /^\s*(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+[`"[]?(\w+)/i;
const CTE_WRITE = /^\s*with\b[\s\S]*\b(insert|replace|update|delete)\b/i;

/** The leased table a batch writes without starting with the guard, or null. */
export function unguardedWrite(statements: readonly { sql: string }[]): string | null {
  if (statements[0]?.sql === GUARD_SQL) return null;
  for (const { sql } of statements) {
    const table = WRITE.exec(sql)?.[1];
    if (table !== undefined && LEASED.has(table)) return table;
    // A write behind a WITH clause: its target is not parsed here, so it needs the guard too.
    if (table === undefined && CTE_WRITE.test(sql)) return "(with)";
  }
  return null;
}

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1_TABLES, DERIVED_TABLES } from "@/ops/tables";
import { query, resetSchema, sqliteWithSchema } from "./helpers/db";

type Col = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
type Named = { name: string; sql: string };

beforeAll(resetSchema);

// Bookkeeping tables that are not part of the schema: drizzle's migration journal, AUTOINCREMENT's
// counters, and D1's own (_cf_*).
const OWN = "name not like 'sqlite_%' and name not like '\\_cf\\_%' escape '\\' and name <> '__drizzle_migrations'";

describe("schema parity with the Python SQLite schema", () => {
  const lite = sqliteWithSchema();
  const all = <T>(sql: string) => lite.prepare(sql).all() as T[];
  const tables = all<{ name: string }>(`select name from sqlite_master where type='table' and ${OWN} order by name`).map((r) => r.name);
  // A parenthesized default is the same expression; drizzle-kit writes CURRENT_TIMESTAMP as (CURRENT_TIMESTAMP).
  const column = (c: Col) => ({ name: c.name, type: c.type.toLowerCase(), notnull: c.notnull === 1 || c.pk > 0, dflt: c.dflt_value?.replace(/^\((.*)\)$/, "$1") ?? null, pk: c.pk });
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : 1);

  it("has every SQLite table and, besides them, only the derived and D1-only tables", async () => {
    const rows = await query<{ name: string }>(`select name from sqlite_master where type='table' and ${OWN} order by name`);
    expect(tables).toHaveLength(25);
    expect(rows.map((r) => r.name)).toEqual([...tables, ...DERIVED_TABLES, ...D1_TABLES].sort());
  });

  it("has the same columns, types, nullability, defaults and primary keys in every table", async () => {
    for (const table of tables) {
      const want = all<Col>(`pragma table_info(${table})`).map(column).sort(byName);
      const have = (await query<Col>(`pragma table_info(${table})`)).map(column).sort(byName);
      expect({ table, cols: have }).toEqual({ table, cols: want });
    }
  });

  it("has the same unique constraints and indexes in every table", async () => {
    type Index = { name: string; unique: number; origin: string };
    // Python declares UNIQUE inline (automatic indexes), drizzle-kit as named indexes: compare columns.
    const shape = async (list: (sql: string) => Promise<unknown[]>, table: string) => {
      const out: string[] = [];
      for (const idx of (await list(`pragma index_list(${table})`)) as Index[]) {
        if (idx.origin === "pk") continue;
        const cols = ((await list(`pragma index_info('${idx.name}')`)) as { name: string }[]).map((c) => c.name);
        out.push(`${idx.unique ? "unique" : "index"}(${cols.join(",")})`);
      }
      return out.sort();
    };
    for (const table of tables) {
      expect({ table, idx: await shape((sql) => query(sql), table) }).toEqual({ table, idx: await shape(async (sql) => all(sql), table) });
    }
  });

  it("has the Python triggers verbatim", async () => {
    const want = all<Named>("select name, sql from sqlite_master where type='trigger' order by name");
    const have = await query<Named>(`select name, sql from sqlite_master where type='trigger' and name in (${want.map(() => "?").join(",")}) order by name`, want.map((t) => t.name));
    expect(want).toHaveLength(6);
    expect(have).toEqual(want);
  });

  it("compares and orders text like SQLite BINARY: no column declares another collation", async () => {
    const declared = await query<Named>("select name, sql from sqlite_master where sql like '%collate%'");
    expect(declared).toEqual([]);
  });
});

async function seedDraft() {
  await query(`insert into proposal_drafts values ('d1','t',1,'{}','{}','null','c','u',null,'r1','{}')`);
  await query(`insert into proposal_draft_revisions values ('d1',1,'body','{}','[]','{}','r1','{}','c')`);
}
async function seedIntent(status = "prepared") {
  await seedDraft();
  await query(`insert into submission_intents values ('s1','d1',1,'{}','h',null,?1,1,'c','u',null,null,null,null,'q1','{}')`, [status]);
  await query(`insert into submission_events values ('s1',1,'prepared','{}','c')`);
}

describe("immutability triggers", () => {
  beforeEach(resetSchema);

  // SQLite has no TRUNCATE; DELETE without WHERE is the only way to empty a table and fires the triggers.
  it("rejects UPDATE and DELETE of proposal draft revisions", async () => {
    await seedDraft();
    await expect(query("update proposal_draft_revisions set body='x'")).rejects.toThrow("Proposal versions are immutable");
    await expect(query("delete from proposal_draft_revisions")).rejects.toThrow("Proposal versions must be retained");
  });

  it("rejects UPDATE and DELETE of submission events", async () => {
    await seedIntent();
    await expect(query("update submission_events set evidence='x'")).rejects.toThrow("Submission events are immutable");
    await expect(query("delete from submission_events")).rejects.toThrow("Submission events must be retained");
  });

  it("keeps submission identity immutable and allows only safe transitions", async () => {
    await seedIntent();
    await expect(query("update submission_intents set snapshot='{\"x\":1}'")).rejects.toThrow("immutable");
    await expect(query("update submission_intents set approval_hash=null, request_payload='{ }'")).rejects.toThrow("immutable");
    await expect(query("update submission_intents set status='attempted'")).rejects.toThrow("Unsafe submission transition");
    await query("update submission_intents set status='approved', revision=2");
    await query("update submission_intents set status='attempted', revision=3");
    await expect(query("update submission_intents set status='cancelled'")).rejects.toThrow("Unsafe submission transition");
    await query("update submission_intents set status='unknown', revision=4");
    await expect(query("update submission_intents set status='accepted'")).rejects.toThrow("Unsafe submission transition");
  });

  it("keeps digest snapshots immutable and allows only pending→attempted→sent|unknown", async () => {
    await query("insert into digest_outbox (id, local_date, recipient, snapshot) values ('i1','2026-10-23','r','{}')");
    await expect(query("update digest_outbox set snapshot='{ }'")).rejects.toThrow("Digest identity and snapshot are immutable");
    await expect(query("update digest_outbox set status='sent', delivery_receipt='x'")).rejects.toThrow("Unsafe digest state transition");
    await query("update digest_outbox set status='attempted'");
    await expect(query("update digest_outbox set status='sent'")).rejects.toThrow("digest_outbox_sent_receipt");
    await query("update digest_outbox set status='sent', delivery_receipt='receipt'");
    await expect(query("update digest_outbox set status='attempted'")).rejects.toThrow("Unsafe digest state transition");
  });

  it("still allows mutable columns to change", async () => {
    await query("insert into digest_outbox (id, local_date, recipient, snapshot) values ('i1','2026-10-23','r','{}')");
    await query("update digest_outbox set attempted_at='t'");
    await seedIntent();
    await query("update submission_intents set reconciliation='{}'");
  });
});

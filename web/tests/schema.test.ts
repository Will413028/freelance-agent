import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DERIVED_TABLES } from "@/ops/tables";
import { pool, resetSchema, sqliteWithSchema } from "./helpers/db";

type Col = { name: string; notnull: number; pk: number };

beforeAll(resetSchema);
afterAll(async () => { await pool.end(); });

describe("schema parity with the Python SQLite schema", () => {
  const lite = sqliteWithSchema();
  const tables = (lite.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all() as { name: string }[]).map((r) => r.name);

  it("has every SQLite table and, besides them, only the derived tables", async () => {
    const { rows } = await pool.query("select table_name from information_schema.tables where table_schema='public' order by table_name");
    expect(tables).toHaveLength(25);
    expect(rows.map((r) => r.table_name)).toEqual([...tables, ...DERIVED_TABLES].sort());
  });

  it("has the same columns and nullability in every table", async () => {
    for (const table of tables) {
      const want = (lite.prepare(`pragma table_info(${table})`).all() as Col[])
        .map((c) => ({ name: c.name, notnull: c.notnull === 1 || c.pk > 0 }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const { rows } = await pool.query(
        "select column_name, is_nullable from information_schema.columns where table_schema='public' and table_name=$1 order by column_name collate \"C\"",
        [table],
      );
      expect({ table, cols: rows.map((r) => ({ name: r.column_name, notnull: r.is_nullable === "NO" })) }).toEqual({ table, cols: want });
    }
  });

  it("compares and orders text like SQLite BINARY", async () => {
    const { rows } = await pool.query("select v from (values ('b'), ('B'), ('a'), ('é'), ('Z')) t(v) order by v collate \"C\"");
    const { rows: col } = await pool.query(
      "select collation_name from information_schema.columns where table_schema='public' and data_type='text' group by collation_name",
    );
    expect(col).toEqual([{ collation_name: "C" }]);
    expect(rows.map((r) => r.v)).toEqual(["B", "Z", "a", "b", "é"]);
  });
});

async function seedDraft() {
  await pool.query(`insert into proposal_drafts values ('d1','t',1,'{}','{}','null','c','u',null,'r1','{}')`);
  await pool.query(`insert into proposal_draft_revisions values ('d1',1,'body','{}','[]','{}','r1','{}','c')`);
}
async function seedIntent(status = "prepared") {
  await seedDraft();
  await pool.query(`insert into submission_intents values ('s1','d1',1,'{}','h',null,$1,1,'c','u',null,null,null,null,'q1','{}')`, [status]);
  await pool.query(`insert into submission_events values ('s1',1,'prepared','{}','c')`);
}

describe("immutability triggers", () => {
  beforeEach(resetSchema);

  it("rejects UPDATE, DELETE and TRUNCATE of proposal draft revisions", async () => {
    await seedDraft();
    await expect(pool.query("update proposal_draft_revisions set body='x'")).rejects.toThrow("Proposal versions are immutable");
    await expect(pool.query("delete from proposal_draft_revisions")).rejects.toThrow("Proposal versions must be retained");
    await expect(pool.query("truncate proposal_draft_revisions cascade")).rejects.toThrow("Proposal versions must be retained");
  });

  it("rejects UPDATE, DELETE and TRUNCATE of submission events", async () => {
    await seedIntent();
    await expect(pool.query("update submission_events set evidence='x'")).rejects.toThrow("Submission events are immutable");
    await expect(pool.query("delete from submission_events")).rejects.toThrow("Submission events must be retained");
    await expect(pool.query("truncate submission_events")).rejects.toThrow("Submission events must be retained");
  });

  it("keeps submission identity immutable and allows only safe transitions", async () => {
    await seedIntent();
    await expect(pool.query("update submission_intents set snapshot='{\"x\":1}'")).rejects.toThrow("immutable");
    await expect(pool.query("update submission_intents set approval_hash=null, request_payload='{ }'")).rejects.toThrow("immutable");
    await expect(pool.query("update submission_intents set status='attempted'")).rejects.toThrow("Unsafe submission transition");
    await pool.query("update submission_intents set status='approved', revision=2");
    await pool.query("update submission_intents set status='attempted', revision=3");
    await expect(pool.query("update submission_intents set status='cancelled'")).rejects.toThrow("Unsafe submission transition");
    await pool.query("update submission_intents set status='unknown', revision=4");
    await expect(pool.query("update submission_intents set status='accepted'")).rejects.toThrow("Unsafe submission transition");
  });

  it("keeps digest snapshots immutable and allows only pending→attempted→sent|unknown", async () => {
    await pool.query("insert into digest_outbox (id, local_date, recipient, snapshot) values ('i1','2026-10-23','r','{}')");
    await expect(pool.query("update digest_outbox set snapshot='{ }'")).rejects.toThrow("Digest identity and snapshot are immutable");
    await expect(pool.query("update digest_outbox set status='sent', delivery_receipt='x'")).rejects.toThrow("Unsafe digest state transition");
    await pool.query("update digest_outbox set status='attempted'");
    await expect(pool.query("update digest_outbox set status='sent'")).rejects.toThrow("digest_outbox_sent_receipt");
    await pool.query("update digest_outbox set status='sent', delivery_receipt='receipt'");
    await expect(pool.query("update digest_outbox set status='attempted'")).rejects.toThrow("Unsafe digest state transition");
  });

  it("still allows mutable columns to change", async () => {
    await pool.query("insert into digest_outbox (id, local_date, recipient, snapshot) values ('i1','2026-10-23','r','{}')");
    await pool.query("update digest_outbox set attempted_at='t'");
    await seedIntent();
    await pool.query("update submission_intents set reconciliation='{}'");
  });
});

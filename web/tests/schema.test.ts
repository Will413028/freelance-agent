import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, resetSchema, leased } from "./helpers/db";

type Named = { name: string; sql: string };

beforeAll(resetSchema);

// Structure drift (schema.ts against the migrations) is `pnpm db:check`, run in CI; the tests here
// cover what drizzle does not model: collation, and below the immutability triggers of 0001_triggers.sql by their behaviour.
describe("schema", () => {
  it("compares and orders text like SQLite BINARY: no column declares another collation", async () => {
    const declared = await query<Named>("select name, sql from sqlite_master where sql like '%collate%'");
    expect(declared).toEqual([]);
  });
});

async function seedDraft() {
  await leased(`insert into proposal_drafts values ('d1','t',1,'{}','{}','null','c','u',null,'r1','{}')`);
  await leased(`insert into proposal_draft_revisions values ('d1',1,'body','{}','[]','{}','r1','{}','c')`);
}
async function seedIntent(status = "prepared") {
  await seedDraft();
  await leased(`insert into submission_intents values ('s1','d1',1,'{}','h',null,?1,1,'c','u',null,null,null,null,'q1','{}')`, [status]);
  await leased(`insert into submission_events values ('s1',1,'prepared','{}','c')`);
}

describe("immutability triggers", () => {
  beforeEach(resetSchema);

  // SQLite has no TRUNCATE; DELETE without WHERE is the only way to empty a table and fires the triggers.
  it("rejects UPDATE and DELETE of proposal draft revisions", async () => {
    await seedDraft();
    await expect(leased("update proposal_draft_revisions set body='x'")).rejects.toThrow("Proposal versions are immutable");
    await expect(leased("delete from proposal_draft_revisions")).rejects.toThrow("Proposal versions must be retained");
  });

  it("rejects UPDATE and DELETE of submission events", async () => {
    await seedIntent();
    await expect(leased("update submission_events set evidence='x'")).rejects.toThrow("Submission events are immutable");
    await expect(leased("delete from submission_events")).rejects.toThrow("Submission events must be retained");
  });

  it("keeps submission identity immutable and allows only safe transitions", async () => {
    await seedIntent();
    await expect(leased("update submission_intents set snapshot='{\"x\":1}'")).rejects.toThrow("immutable");
    await expect(leased("update submission_intents set approval_hash=null, request_payload='{ }'")).rejects.toThrow("immutable");
    await expect(leased("update submission_intents set status='attempted'")).rejects.toThrow("Unsafe submission transition");
    await leased("update submission_intents set status='approved', revision=2");
    await leased("update submission_intents set status='attempted', revision=3");
    await expect(leased("update submission_intents set status='cancelled'")).rejects.toThrow("Unsafe submission transition");
    await leased("update submission_intents set status='unknown', revision=4");
    await expect(leased("update submission_intents set status='accepted'")).rejects.toThrow("Unsafe submission transition");
  });

  it("keeps digest snapshots immutable and allows only pending→attempted→sent|unknown", async () => {
    await leased("insert into digest_outbox (id, local_date, recipient, snapshot) values ('i1','2026-10-23','r','{}')");
    await expect(leased("update digest_outbox set snapshot='{ }'")).rejects.toThrow("Digest identity and snapshot are immutable");
    await expect(leased("update digest_outbox set status='sent', delivery_receipt='x'")).rejects.toThrow("Unsafe digest state transition");
    await leased("update digest_outbox set status='attempted'");
    await expect(leased("update digest_outbox set status='sent'")).rejects.toThrow("digest_outbox_sent_receipt");
    await leased("update digest_outbox set status='sent', delivery_receipt='receipt'");
    await expect(leased("update digest_outbox set status='attempted'")).rejects.toThrow("Unsafe digest state transition");
  });

  it("still allows mutable columns to change", async () => {
    await leased("insert into digest_outbox (id, local_date, recipient, snapshot) values ('i1','2026-10-23','r','{}')");
    await leased("update digest_outbox set attempted_at='t'");
    await seedIntent();
    await leased("update submission_intents set reconciliation='{}'");
  });
});

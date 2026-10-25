import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ingest, mailRecords, recordMail, runSource, saveMailState, sourcesIn } from "@/modules/collection/public";
import { ReceivingClient } from "@/modules/collection/mail/receiving";
import { syncMail, syncMailSource } from "@/modules/collection/mail/sync";
import { RUNNERS } from "@/modules/collection/registry";
import { fromisoformat } from "@/platform/py/datetime";
import { encode } from "@/platform/py/json";
import { asDict, PyError, type PyDict } from "@/platform/py/value";
import { transport } from "./helpers/resend";
import { db, pool, resetSchema } from "./helpers/db";
import { attemptAsync, fixture, untag, type Expect, type Tagged } from "./helpers/golden";

// Replays the Resend sync scenarios gen_golden.py ran through resend_sync._sync against the Python
// SQLiteStore and the real ReceivingClient (plan step 9a): every run's result and requests, and the
// stored mail state, ingestion records, content versions, opportunities, receipts and health, must
// match. The scenarios carry the cases of backend/tests/collection/test_resend_sync.py and
// bootstrap/test_linkedin_receiving.py; checked_at columns are wall-clock defaults and left out.

type Pages = Record<string, [number, string]>;
type Run = { pages: Pages; max_messages: number; limits: { max_pages?: number; max_seconds?: number }; ticks: number[] | null; recipient: string; expect: Expect<string>; calls: string[] };
type Scenario = { source: string; setup: { op: string; job?: Tagged; receipt_id?: string; message_id?: string; status?: string; reason?: string; state?: Tagged }[]; runs: Run[]; tables: Record<string, unknown[][]> };
const golden = fixture<{ now: string; mail_sync: Record<string, Scenario>; mail_sync_9b: Record<string, Scenario> }>("golden.json");
const NOW = fromisoformat(golden.now);
const TARGET = "test@inbox.resend.app";

const TABLES: [string, string, string][] = [
  ["mail_sync_state", "source,recipient,state", "source,recipient"],
  ["mail_ingestion", "source,recipient,message_id,status,reason,retry_pending", "source,recipient,message_id"],
  ["mail_content_versions", "opportunity_id,fingerprint,job", "opportunity_id,fingerprint"],
  ["opportunities", "id,source,external_id,item", "id"],
  ["source_receipts", "source,receipt_id,opportunity_id", "source,receipt_id"],
  ["source_health", "source,status", "source"],
];

/** Python's monotonic patched to next() over the ticks: past the end it raises StopIteration. */
const ticker = (ticks: number[] | null) => {
  let i = 0;
  return () => {
    if (!ticks) return 0;
    if (i >= ticks.length) throw new PyError("StopIteration", "");
    return ticks[i++];
  };
};

async function replay(s: Scenario) {
  for (const op of s.setup) {
    if (op.op === "ingest") await ingest(db, untag(op.job!), op.receipt_id!, NOW);
    else if (op.op === "record") await recordMail(db, s.source, TARGET, op.message_id!, op.status!, op.reason ?? null);
    // store.retry_mail (the recovery page arrives in step 10): only a rejected message is requeued.
    else if (op.op === "retry") await pool.query("update mail_ingestion set retry_pending = 1 where source = $1 and message_id = $2 and status = 'rejected'", [s.source, op.message_id]);
    else if (op.op === "state") await saveMailState(db, s.source, TARGET, asDict(untag(op.state!)));
    else throw new Error(op.op);
  }
  const runs = [];
  for (const run of s.runs) {
    const calls: string[] = [];
    const client = new ReceivingClient("re_synthetic", { request: transport(run.pages, calls), pause: async () => {}, sources: [s.source] });
    const expectResult = await attemptAsync(async () => encode(await syncMail(db, client, run.recipient, s.source, {
      maxMessages: run.max_messages, maxPages: run.limits.max_pages, maxSeconds: run.limits.max_seconds, monotonic: ticker(run.ticks), clock: () => NOW,
    })));
    runs.push({ expect: expectResult, calls });
  }
  const tables: Record<string, unknown[][]> = {};
  for (const [table, columns, order] of TABLES) {
    tables[table] = (await pool.query({ text: `select ${columns} from ${table} order by ${order}`, rowMode: "array" })).rows;
  }
  return { runs, tables };
}

beforeEach(resetSchema);
afterAll(() => pool.end());

describe("Resend sync scenarios (Python ground truth)", () => {
  const all = { ...golden.mail_sync, ...golden.mail_sync_9b };
  it.each(Object.keys(all))("%s", async (name) => {
    const s = all[name];
    const got = await replay(s);
    expect(got.runs).toEqual(s.runs.map((r) => ({ expect: r.expect, calls: r.calls })));
    expect(got.tables).toEqual(s.tables);
  });
});

describe("Resend sync (TS-only checks)", () => {
  const scenario = golden.mail_sync.tasker_fetch_failure_then_template;
  it("reports stage counts without message content", async () => {
    const client = new ReceivingClient("re_synthetic", { request: transport(scenario.runs[1].pages), pause: async () => {} });
    const result = await syncMail(db, client, TARGET, "tasker", { clock: () => NOW });
    expect(encode(result)).not.toContain("SECRET");
    expect(encode(asDict(result.at("error_stages")))).toBe('{"template": 1}');
  });
  it("records a message once; only an explicit retry may overwrite it (store.record_mail)", async () => {
    const rows = async () => (await pool.query("select status, reason, retry_pending from mail_ingestion")).rows;
    await recordMail(db, "tasker", TARGET, "m", "rejected", "template");
    await recordMail(db, "tasker", TARGET, "m", "processed");
    expect(await rows()).toEqual([{ status: "rejected", reason: "template", retry_pending: 0 }]);
    await pool.query("update mail_ingestion set retry_pending = 1");
    await recordMail(db, "tasker", TARGET, "m", "processed");
    expect(await rows()).toEqual([{ status: "processed", reason: null, retry_pending: 0 }]);
  });
  it("never reads a message delivered to another inbox", async () => {
    const ok = golden.mail_sync.tasker_import_and_replay.runs[0];
    const client = new ReceivingClient("re_synthetic", { request: transport(ok.pages), pause: async () => {} });
    const result = await syncMail(db, client, "other@inbox.resend.app", "tasker", { clock: () => NOW });
    expect([result.at("status"), result.at("quarantined")]).toEqual(["failed", 1n]);
    expect((await pool.query("select count(*)::int n from opportunities")).rows[0].n).toBe(0);
    expect([...(await mailRecords(db, "tasker", "other@inbox.resend.app")).values()]).toEqual([{ status: "rejected", reason: "metadata", retryPending: false }]);
  });
  it("runs as a daily source and fails without Resend credentials", async () => {
    const saved = { key: process.env.RESEND_API_KEY, inbox: process.env.RESEND_INBOX };
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_INBOX;
    try {
      expect(await runSource(db, "tasker", RUNNERS.tasker)).toEqual({ status: "failed", reason: "source_unavailable" });
      expect(await runSource(db, "linkedin", RUNNERS.linkedin)).toEqual({ status: "failed", reason: "source_unavailable" });
      const result: PyDict = await syncMailSource(db, "tasker");
      expect(encode(result)).toBe('{"status": "failed", "reason": "source_unavailable"}');
      const health = await sourcesIn(db);
      expect([health.at("tasker"), health.at("linkedin")]).toEqual(["failed", "failed"]);
    } finally {
      if (saved.key !== undefined) process.env.RESEND_API_KEY = saved.key;
      if (saved.inbox !== undefined) process.env.RESEND_INBOX = saved.inbox;
    }
  });
});

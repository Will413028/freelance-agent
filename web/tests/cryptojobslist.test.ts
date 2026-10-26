import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existingSourceIds, runSource, sourcesIn } from "@/modules/collection/public";
import { parse, syncCryptoJobsList } from "@/modules/collection/sources/cryptojobslist";
import { PyDateTime } from "@/platform/py/datetime";
import { encode, loadsDict } from "@/platform/py/json";
import { PyDict } from "@/platform/py/value";
import { db, pool, resetSchema } from "./helpers/db";

// backend/tests/collection/test_cryptojobslist.py, plus the source_batch atomicity plan step 7 adds.

const URL = "https://cryptojobslist.com/jobs/ai-agent-api-acme";
const item = ({ tags = ["freelance", "remote"], location = "Remote", url = URL } = {}) => {
  const links = tags.map((t) => `<a href="https://cryptojobslist.com/${t}">${t}</a>`).join(" ");
  return `<item><title>AI agent API developer</title><link>${url}</link><description><![CDATA[<p>Tags: ${links}</p><p>Build an AI agent and API.</p>]]></description><media:location>${location}</media:location></item>`;
};
const feed = (items: string = item()) => Buffer.from(
  `<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><lastBuildDate>Sat, 26 Sep 2026 01:00:00 GMT</lastBuildDate>${items}</channel></rss>`);
const at = (d: number) => new PyDateTime(2026, 9, d, 0, 0, 0, 0, 0n);
const first = (r: PyDict) => (r.req("jobs") as PyDict[])[0];
const plus = (dt: PyDateTime, days: number) => PyDateTime.fromUtcMicros(dt.utcMicros() + BigInt(days) * 86_400_000_000n);

beforeEach(resetSchema);
afterAll(() => pool.end());

describe("cryptojobslist (Python cases)", () => {
  it("does not fill a missing job date from the feed build or the observation", () => {
    const a = first(parse(feed(), at(26))), b = first(parse(feed(), at(27)));
    expect(a.at("published_at")).toBeNull();
    expect(a.at("received_at")).not.toBe(b.at("received_at"));
    expect(a.at("receipt_id")).toBe(b.at("receipt_id"));
    expect(a.at("weekly_hours")).toBeNull();
    expect(a.at("budget_max")).toBeNull();
  });

  it("does not read the smart-contract tag as freelance, and full-time wins", () => {
    expect(first(parse(feed(item({ tags: ["contract", "smart-contract", "remote"] })))).at("kind")).toBeNull();
    expect(first(parse(feed(item({ tags: ["freelance", "full-time", "remote"] })))).at("kind")).toBe("full_time");
    expect(first(parse(feed(item({ location: "Remote United States" })))).at("taiwan_eligible")).toBe(false);
    const unknown = first(parse(feed(item({ location: "" }))));
    expect(unknown.at("location_evidence")).toBeNull();
    expect(unknown.at("taiwan_eligible")).toBeNull();
    expect(unknown.at("remote_evidence")).toBe(true);
    expect(first(parse(Buffer.from(feed().toString().replace("Tags:", "Our partners:")))).at("kind")).toBeNull();
  });

  it("isolates a bad URL and rejects XML declarations", () => {
    const r = parse(feed(item() + item({ url: "https://evil.example/jobs/ai-agent" })));
    expect(r.at("seen")).toBe(2n);
    expect(r.at("rejected_count")).toBe(1n);
    expect(() => parse(Buffer.concat([Buffer.from("<!DOCTYPE rss>"), feed()]))).toThrow(expect.objectContaining({ pyType: "ValueError" }));
    expect(() => parse(feed(""))).toThrow(expect.objectContaining({ pyType: "ValueError" }));
  });

  it("keeps a manual draft through a replay and reports partial health", async () => {
    const now = PyDateTime.now();
    const a = parse(feed(), now);
    expect((await syncCryptoJobsList(db, async () => a)).at("jobs")).toBe(1n);
    // store.review(id, 'edit', version, text=...) lives in step 11; write the field it sets.
    const { rows } = await pool.query("select id, item from opportunities");
    const edited = loadsDict(rows[0].item);
    edited.set("proposal", "Human proposal");
    await pool.query("update opportunities set item = $1 where id = $2", [encode(edited), rows[0].id]);
    const b = parse(feed(), plus(now, 1));
    b.set("rejected_count", 1n);
    expect((await syncCryptoJobsList(db, async () => b)).at("status")).toBe("partial");
    const after = await pool.query("select item from opportunities");
    expect(after.rows.length).toBe(1);
    expect(loadsDict(after.rows[0].item).at("proposal")).toBe("Human proposal");
    expect((await sourcesIn(db)).at("cryptojobslist")).toBe("failed");
  });
});

describe("cryptojobslist source detail (plan step 10a)", () => {
  // 2026-10-26 shadow: Python's result carries the feed's lastBuildDate text, which the SourceDetail
  // contract refuses, so a healthy day was recorded as failed/invalid_source_result.
  it("records a healthy feed with a build date as ok", async () => {
    const r = parse(feed(), PyDateTime.now());
    expect(await runSource(db, "cryptojobslist", (d) => syncCryptoJobsList(d, async () => r)))
      .toEqual({ seen: 1, rejected_count: 0, complete_scan: false, scope: "official_rss_window_no_job_dates", jobs: 1, status: "ok" });
  });
});

describe("cryptojobslist source_batch (plan step 7)", () => {
  it("writes nothing, health included, when the batch fails midway", async () => {
    const r = parse(feed(item() + item({ url: "https://cryptojobslist.com/jobs/second-one" })), PyDateTime.now());
    (r.req("jobs") as PyDict[])[1].set("external_id", ""); // ingest raises on the second job
    const status = await runSource(db, "cryptojobslist", (d) => syncCryptoJobsList(d, async () => r));
    expect(status.status).toBe("failed");
    expect((await existingSourceIds(db, "cryptojobslist")).size).toBe(0);
    expect((await pool.query("select count(*)::int as n from source_receipts")).rows[0].n).toBe(0);
    expect((await sourcesIn(db)).at("cryptojobslist")).toBe("failed");
  });
});

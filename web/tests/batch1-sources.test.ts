import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existingSourceIds, runSource, sourcesIn } from "@/modules/collection/public";
import { syncCommunity } from "@/modules/collection/sources/community-jobs";
import { normalize as gobNormalize, syncGetOnBoard } from "@/modules/collection/sources/getonboard";
import { syncHimalayas } from "@/modules/collection/sources/himalayas";
import { encode, loadsDict } from "@/platform/py/json";
import { PyDict, PyError, type PyValue } from "@/platform/py/value";
import { db, pool, resetSchema } from "./helpers/db";

// The store cases of backend/tests/collection/test_himalayas.py, test_getonboard.py and
// test_community_jobs.py (plan step 8, batch 1). runSource marks the source failed first, as each
// Python sync does on its first line.

const hima = (changes: Record<string, PyValue> = {}) => PyDict.of({
  title: "AI agent backend engineer", description: "<p>Build AI agents and APIs</p>", employmentType: "Contractor",
  locationRestrictions: [], timezoneRestrictions: [], pubDate: 1789746632n, expiryDate: 1893456000n,
  applicationLink: "https://himalayas.app/companies/example/jobs/engineer", guid: "https://himalayas.app/companies/example/jobs/engineer", ...changes,
});
const gob = (changes: Record<string, PyValue> = {}) => PyDict.of({
  id: "acme-ai-agent",
  attributes: PyDict.of({
    title: "Part time AI agent backend engineer", description: "<p>Build an AI agent and API.</p>",
    modality: PyDict.of({ data: PyDict.of({ id: 42n }) }), remote: true, remote_modality: "fully_remote",
    countries: ["Remote"], published_at: BigInt(Math.floor(Date.now() / 1000)),
    category_name: "Programming", lang: "en", min_salary: 1000n, max_salary: 2000n, ...changes,
  }),
  links: PyDict.of({ public_url: "https://www.getonbrd.com/jobs/acme-ai-agent" }),
});
const batch = (job: PyDict, rejected = 0n) => PyDict.of({ jobs: [job], seen: 1n, rejected_count: rejected, pages: 1n, truncated: false });

beforeEach(resetSchema);
afterAll(() => pool.end());

describe("himalayas.sync", () => {
  it("does not import full-time, expired or wrong-country listings", async () => {
    const result = await syncHimalayas(db, async () => [hima(), hima({ employmentType: "Full Time", guid: "b" }), hima({ expiryDate: 1n, guid: "c" }), hima({ locationRestrictions: ["United States"], guid: "d" })]);
    expect(result.at("jobs")).toBe(1n);
    expect((await existingSourceIds(db, "himalayas")).size).toBe(1);
    expect((await sourcesIn(db)).at("himalayas")).toBe("ok");
  });
  it("does not import part of a malformed batch", async () => {
    const status = await runSource(db, "himalayas", (d) => syncHimalayas(d, async () => [hima(), hima({ description: "" })]));
    expect(status.status).toBe("failed");
    expect((await existingSourceIds(db, "himalayas")).size).toBe(0);
  });
  it("a repeat sync keeps one opportunity and one revision", async () => {
    await syncHimalayas(db, async () => [hima()]);
    await syncHimalayas(db, async () => [hima()]);
    const { rows } = await pool.query("select item from opportunities");
    expect(rows.map((r) => loadsDict(r.item).at("version"))).toEqual([1n]);
  });
});

describe("getonboard.sync", () => {
  it("a replay and a partial batch keep manual work", async () => {
    const job = gobNormalize(gob(), new Map([["42", "part_time"]]));
    expect((await syncGetOnBoard(db, async () => batch(job))).at("jobs")).toBe(1n);
    // store.review(id, 'edit', version, text=...) lives in step 11; write the field it sets.
    const { rows } = await pool.query("select id, item from opportunities");
    const edited = loadsDict(rows[0].item);
    edited.set("proposal", "Human draft");
    await pool.query("update opportunities set item = $1 where id = $2", [encode(edited), rows[0].id]);
    expect((await syncGetOnBoard(db, async () => batch(job, 1n))).at("status")).toBe("partial");
    const after = await pool.query("select item from opportunities");
    expect(after.rows.length).toBe(1);
    expect(loadsDict(after.rows[0].item).at("proposal")).toBe("Human draft");
    expect((await sourcesIn(db)).at("getonboard")).toBe("failed");
  });
  it("a truncated scan is partial too", async () => {
    const job = gobNormalize(gob(), new Map([["42", "part_time"]]));
    const r = batch(job);
    r.set("truncated", true);
    expect((await syncGetOnBoard(db, async () => r)).at("status")).toBe("partial");
    expect((await sourcesIn(db)).at("getonboard")).toBe("failed");
  });
  it("full-time and non-technical listings never become new candidates", async () => {
    for (const [changes, modality] of [[{}, "full_time"], [{ category_name: "Sales" }, "part_time"]] as const) {
      const job = gobNormalize(gob(changes), new Map([["42", modality]]));
      expect((await syncGetOnBoard(db, async () => batch(job))).at("jobs")).toBe(0n);
    }
  });
  it("writes nothing, health included, when the batch fails midway", async () => {
    const a = gobNormalize(gob(), new Map([["42", "part_time"]]));
    const b = new PyDict(a).update({ external_id: "" }); // ingest raises on the second job
    const r = PyDict.of({ jobs: [a, b], seen: 2n, rejected_count: 0n, pages: 1n, truncated: false });
    expect(await runSource(db, "getonboard", (d) => syncGetOnBoard(d, async () => r))).toEqual({ status: "failed", reason: "source_unavailable" });
    expect((await existingSourceIds(db, "getonboard")).size).toBe(0);
    expect((await sourcesIn(db)).at("getonboard")).toBe("failed");
  });
});

describe("community_jobs.sync", () => {
  it("a failed fetch does not report an empty success", async () => {
    const status = await runSource(db, "v2ex", (d) => syncCommunity(d, "v2ex", async () => { throw new PyError("ValueError", ""); }));
    expect(status.status).toBe("failed");
    expect((await existingSourceIds(db, "v2ex")).size).toBe(0);
    expect((await sourcesIn(db)).at("v2ex")).toBe("failed");
  });
  it("imports qualifying leads and reports ok", async () => {
    const { hnJob } = await import("@/modules/collection/sources/community-jobs");
    const j = hnJob(PyDict.of({ id: 123n, type: "comment", parent: 10n, time: BigInt(Math.floor(Date.now() / 1000)), text: "Acme | Remote | part-time backend engineer | Build AI agents" }), 10n)!;
    const result = await syncCommunity(db, "hackernews", async () => [j]);
    expect(result.at("jobs")).toBe(1n);
    expect((await sourcesIn(db)).at("hackernews")).toBe("ok");
  });
});

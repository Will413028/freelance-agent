import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runSource, sourcesIn } from "@/modules/collection/public";
import { SourceBatch } from "@/modules/collection/ingest";
import { syncPublicFeed, type FeedSource } from "@/modules/collection/sources/public-feeds";
import { encode, loadsDict } from "@/platform/py/json";
import { asDict, PyDict, type PyValue } from "@/platform/py/value";
import { db, pool, resetSchema } from "./helpers/db";

// The store cases of backend/tests/collection/test_public_feeds.py (plan step 8, batch 2). runSource
// marks the source failed first, as public_feeds.sync does on its first line. The fetch cases are in
// src/modules/collection/sources/public-feeds.test.ts; parse() has no production caller.

const nowIso = () => new Date().toISOString().replace("Z", "+00:00");
const rfc2822 = (d = new Date()) => d.toUTCString();
const remote = (changes: Record<string, unknown> = {}) => ({
  id: "123", position: "Contract Backend API engineer", description: "<p>Build API integrations.</p>",
  url: "https://remoteOK.com/remote-jobs/remote-api-123", tags: ["contract", "backend"],
  date: nowIso(), location: "", salary_min: 0, salary_max: 0, ...changes,
});
const json = (v: unknown) => Buffer.from(JSON.stringify(v));
const rss = ({ title = "Part-time Backend API developer", description = "Build API integrations.", extra = "", date = rfc2822() } = {}) => Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Jobs</title><item>
<title><![CDATA[${title}]]></title><description><![CDATA[<p>${description}</p>]]></description>
<link>https://www.realworkfromanywhere.com/jobs/backend-123</link><guid>https://www.realworkfromanywhere.com/jobs/backend-123</guid><pubDate>${date}</pubDate>${extra}</item></channel></rss>`);

const run = async (data: Uint8Array, source: FeedSource = "remoteok") => {
  let result: PyDict | null = null;
  const status = await runSource(db, source, async (d) => (result = await syncPublicFeed(d, source, async () => data)));
  return status.status === "failed" ? PyDict.of({ status: "failed" }) : result!;
};
const items = async () => (await pool.query("select id, item from opportunities order by id")).rows.map((r) => ({ id: r.id as string, item: loadsDict(r.item) }));
const job = (item: PyDict) => asDict(item.at("job"));

beforeEach(resetSchema);
afterAll(() => pool.end());

describe("public_feeds.sync (Python cases)", () => {
  it("keeps the description, attribution, unknowns and the actual date", async () => {
    const result = await run(json([{ legal: "Link to Remote OK" }, remote({ date: "2026-09-18T12:00:00+00:00", salary_min: 50000, salary_max: 80000 })]));
    expect(result.at("status")).toBe("ok");
    // A fixed date, as in the Python test: both stop importing it after 2026-12-17 (the 90-day window).
    const j = job((await items())[0].item);
    expect(j.at("description")).toBe("Build API integrations.");
    expect(j.at("published_at")).toBe("2026-09-18T12:00:00+00:00");
    expect(j.at("attribution")).toBe("Remote OK");
    expect(j.at("kind")).toBe("contract");
    for (const key of ["weekly_hours", "taiwan_eligible", "timezone_compatible", "budget_max", "budget_min", "free_apply"]) expect(j.at(key)).toBeNull();
    expect(asDict(j.at("salary_evidence")).at("min")).toBe(50000n);
    expect(asDict(j.at("salary_evidence")).at("period")).toBeNull();
  });

  it("repairs only enclosure ampersands and keeps the full text", async () => {
    const result = await run(rss({ description: "R&D API &amp; automation", extra: '<enclosure url="https://example.org/logo?s=200&v=4" />' }), "realworkfromanywhere");
    expect(result.at("status")).toBe("ok");
    const j = job((await items())[0].item);
    expect(j.at("description")).toBe("R&D API & automation");
    expect(j.at("attribution")).toBe("Real Work From Anywhere");
  });

  it("We Work Remotely: attribution, region and the contract filter", async () => {
    const data = Buffer.from(rss({ title: "Contract AI agent engineer", description: "Build an AI agent and API.", extra: "<region>Anywhere in the World</region><category>Programming</category>" })
      .toString().replaceAll("https://www.realworkfromanywhere.com/jobs/backend-123", "https://weworkremotely.com/remote-jobs/company-ai-agent-123"));
    expect((await run(data, "weworkremotely")).at("jobs")).toBe(1n);
    const j = job((await items())[0].item);
    expect(j.at("attribution")).toBe("We Work Remotely");
    expect(j.at("location_evidence")).toBe("Anywhere in the World");
    expect(j.at("free_apply")).toBeNull();
    expect(j.at("kind")).toBe("contract");
  });

  it("Working Nomads: keeps the location and rejects a redirect host", async () => {
    const entry = { url: "https://www.workingnomads.com/job/go/123/", title: "Contract AI agent engineer", description: "<p>Build an AI agent and API.</p>",
      pub_date: nowIso(), tags: "python,agent", location: "Anywhere", category_name: "Development" };
    expect((await run(json([entry]), "workingnomads")).at("jobs")).toBe(1n);
    const j = job((await items())[0].item);
    expect(j.at("attribution")).toBe("Working Nomads");
    expect(j.at("location_evidence")).toBe("Anywhere");
    expect(j.at("kind")).toBe("contract");
    expect(j.at("taiwan_eligible")).toBeNull();
    expect((await run(json([{ ...entry, url: "https://evil.example/job/go/124/" }]), "workingnomads")).at("status")).toBe("partial");
  });

  it("full-time wins over contract, and an unknown work type is not imported", async () => {
    await run(json([remote({ position: "Full-time Contract API", id: "1" }), remote({ position: "API engineer", tags: ["backend"], id: "2" })]));
    expect(await items()).toEqual([]);
  });

  it("an existing listing that turns full-time or closed is evaluated out of the candidates", async () => {
    const original = remote();
    await run(json([original]));
    for (const update of [{ position: "Full-time API engineer" }, { closed: true }]) {
      await run(json([{ ...original, ...update }]));
      expect(asDict((await items())[0].item.at("evaluation")).at("status")).toBe("excluded");
    }
  });

  it("a replay keeps manual work and the revision", async () => {
    const data = json([remote()]);
    await run(data);
    // store.review / store.track live in step 11; write the fields they set.
    const [{ id, item }] = await items();
    item.update({ proposal: "Human proposal", version: 2n, tracking: PyDict.of({ note: "Keep this" }) as PyValue });
    await pool.query("update opportunities set item = $1 where id = $2", [encode(item), id]);
    await run(data);
    const after = (await items())[0].item;
    expect(after.at("proposal")).toBe("Human proposal");
    expect(after.at("version")).toBe(2n);
    expect(asDict(after.at("tracking")).at("note")).toBe("Keep this");
  });

  it("malformed and empty feeds fail without partial writes", async () => {
    for (const data of ["", "{}", "[]", '[{"id": 1},']) {
      expect((await run(Buffer.from(data))).at("status")).toBe("failed");
      expect(await items()).toEqual([]);
    }
    expect((await sourcesIn(db)).at("remoteok")).toBe("failed");
  });

  it("XML rejects DTDs, entities and arbitrary recovery", async () => {
    const base = rss().toString();
    for (const data of [base.replace("<rss", '<!DOCTYPE rss [<!ENTITY x "boom">]><rss'), base.replace("</item>", "</wrong>"), base.replace("<pubDate>", "<pubDate>&undefined;")]) {
      expect((await run(Buffer.from(data), "realworkfromanywhere")).at("status")).toBe("failed");
    }
    expect(await items()).toEqual([]);
  });

  it("old listings are skipped and the scan is bounded to 200", async () => {
    await run(json([remote({ date: new Date(Date.now() - 91 * 86_400_000).toISOString() })]));
    expect(await items()).toEqual([]);
    const result = await run(json(Array.from({ length: 205 }, (_, i) => remote({ id: String(i) }))));
    expect(result.at("seen")).toBe(200n);
    expect((await items()).length).toBe(200);
    expect(result.at("truncated")).toBe(true);
  });

  it("an oversize feed fails and a wrong canonical host is partial", async () => {
    expect((await run(Buffer.alloc(8_000_001, 0x20))).at("status")).toBe("failed");
    expect((await run(json([remote({ url: "https://evil.example/jobs/123" })]))).at("status")).toBe("partial");
  });

  it("an ingest failure rolls back the whole batch", async () => {
    const original = SourceBatch.prototype.ingest;
    const spy = vi.spyOn(SourceBatch.prototype, "ingest").mockImplementation(function (this: SourceBatch, j, receipt) {
      if (asDict(j).at("external_id") === "2") throw new Error("synthetic failure");
      return original.call(this, j, receipt);
    });
    try {
      expect((await run(json([remote({ id: "1" }), remote({ id: "2" })]))).at("status")).toBe("failed");
    } finally {
      spy.mockRestore();
    }
    expect(await items()).toEqual([]);
  });

  it("explicit body contract evidence, without the smart-contract false positive", async () => {
    expect((await run(rss({ title: "Backend API engineer", description: "This position is offered on a contractor basis. Build API integrations." }), "realworkfromanywhere")).at("jobs")).toBe(1n);
    expect(job((await items())[0].item).at("kind")).toBe("contract");
    const other = json([remote({ position: "Smart Contract API engineer", tags: ["blockchain"], description: "Build smart contracts and API integrations." })]);
    expect((await run(other)).at("jobs")).toBe(0n);
  });

  it("a bad canonical is visible as partial and a valid replay keeps manual work", async () => {
    const data = json([remote(), remote({ id: "2", url: "https://remoteok.com/remote-jobs/" })]);
    const result = await run(data);
    expect(result.at("status")).toBe("partial");
    expect(result.at("rejected_count")).toBe(1n);
    expect(result.at("seen")).toBe(2n);
    expect(result.at("jobs")).toBe(1n);
    expect(result.at("reason")).toBe("invalid_individual_listings_rejected");
    expect((await sourcesIn(db)).at("remoteok")).toBe("failed");
    const [{ id, item }] = await items();
    item.update({ proposal: "Human partial proposal", version: 2n });
    await pool.query("update opportunities set item = $1 where id = $2", [encode(item), id]);
    await run(data);
    const after = await items();
    expect(after.length).toBe(1);
    expect(after[0].item.at("proposal")).toBe("Human partial proposal");
    expect(after[0].item.at("version")).toBe(2n);
  });
});

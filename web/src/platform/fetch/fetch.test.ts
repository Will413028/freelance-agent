import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFetcher, FetchError, type FetchPolicy } from ".";

// Plan step 4: tier 1 reading against a local server.

const policy: FetchPolicy = { maxTier: "plain", minIntervalMs: 0, maxRequestsPerRun: 10 };
let server: Server, base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect") res.writeHead(302, { location: "/ok" }).end();
    else if (req.url === "/429") res.writeHead(429).end();
    else if (req.url === "/503") res.writeHead(503).end();
    else if (req.url === "/404") res.writeHead(404).end();
    else if (req.url === "/slow") setTimeout(() => res.writeHead(200).end("late"), 500);
    else if (req.url === "/1024") res.writeHead(200).end("x".repeat(1024));
    else res.writeHead(200).end('{"jobs": []}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as FetchError;
  }
  throw new Error("expected a FetchError");
};

describe("tier 1 fetcher", () => {
  it("returns a 200 body with its tier", async () => {
    const r = await createFetcher(policy).get({ url: `${base}/ok`, maxBytes: 100, timeoutMs: 2000 });
    expect([r.status, new TextDecoder().decode(r.body), r.tier]).toEqual([200, '{"jobs": []}', "plain"]);
  });

  it("does not follow redirects and reports any other status as http_status", async () => {
    const e = await failure(createFetcher(policy).get({ url: `${base}/redirect`, maxBytes: 100, timeoutMs: 2000 }));
    expect([e.kind, e.status, e.transient]).toEqual(["http_status", 302, false]);
  });

  it("marks 429 and 5xx transient, 404 not", async () => {
    const f = createFetcher(policy);
    const kinds = [];
    for (const p of ["/429", "/503", "/404"]) kinds.push((await failure(f.get({ url: base + p, maxBytes: 100, timeoutMs: 2000 }))).transient);
    expect(kinds).toEqual([true, true, false]);
  });

  it("accepts a body of exactly the cap and refuses it under a cap one byte smaller", async () => {
    const f = createFetcher(policy);
    expect((await f.get({ url: `${base}/1024`, maxBytes: 1024, timeoutMs: 2000 })).body.length).toBe(1024);
    expect((await failure(f.get({ url: `${base}/1024`, maxBytes: 1023, timeoutMs: 2000 }))).kind).toBe("too_large");
  });

  it("reports a timeout and a refused connection by kind, both transient", async () => {
    const f = createFetcher(policy);
    const t = await failure(f.get({ url: `${base}/slow`, maxBytes: 100, timeoutMs: 50 }));
    const n = await failure(f.get({ url: "http://127.0.0.1:1/", maxBytes: 100, timeoutMs: 2000 }));
    expect([t.kind, t.transient, n.kind, n.transient]).toEqual(["timeout", true, "network", true]);
  });

  it("serves concurrent calls one at a time, keeping the interval and the cap", async () => {
    let now = 0;
    const waits: number[] = [];
    const clock = { now: () => now, sleep: async (ms: number) => void (waits.push(ms), (now += ms)) };
    const f = createFetcher({ maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 2 }, clock);
    const got = await Promise.allSettled([1, 2, 3].map(() => f.get({ url: `${base}/ok`, maxBytes: 100, timeoutMs: 2000 })));
    expect([got.map((g) => g.status), waits, f.requests]).toEqual([["fulfilled", "fulfilled", "rejected"], [3_000], 2]);
  });

  it("refuses a URL it cannot read as invalid_url, not transient", async () => {
    for (const url of ["not a url", "ftp://example.com/"]) {
      const e = await failure(createFetcher(policy).get({ url, maxBytes: 100, timeoutMs: 2000 }));
      expect([e.kind, e.transient]).toEqual(["invalid_url", false]);
    }
  });

  it("waits the source's interval between requests and stops at its per-run cap", async () => {
    let now = 1_000;
    const waits: number[] = [];
    const clock = { now: () => now, sleep: async (ms: number) => void (waits.push(ms), (now += ms)) };
    const f = createFetcher({ maxTier: "plain", minIntervalMs: 3_000, maxRequestsPerRun: 2 }, clock);
    await f.get({ url: `${base}/ok`, maxBytes: 100, timeoutMs: 2000 });
    now += 1_000;
    await f.get({ url: `${base}/ok`, maxBytes: 100, timeoutMs: 2000 });
    const e = await failure(f.get({ url: `${base}/ok`, maxBytes: 100, timeoutMs: 2000 }));
    expect([waits, f.requests, e.kind, e.transient]).toEqual([[2_000], 2, "request_limit", false]);
  });
});

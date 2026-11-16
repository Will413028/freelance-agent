import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserTier, createFetcher, serviceBudget, FetchError, TIERS, type FetchPolicy, type Tier, type Transport } from ".";

// Plan step 4 (tier 1), step 8c (tier 2, browser_like) and step 8d (tier 3, browser): each tier's real
// transport against a local server, so all keep the same rules; then the tier choice itself with stub
// transports. Tier 3's service is a stand-in that reads the page with a plain fetch and answers with the
// contract of browser/server.mjs (the real service is tested in browser/ and run on the VM).
let server: Server, base = "";
let service: Server;
const renders: unknown[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect") res.writeHead(302, { location: "/ok" }).end();
    else if (req.url === "/429") res.writeHead(429).end();
    else if (req.url === "/503") res.writeHead(503).end();
    else if (req.url === "/404") res.writeHead(404).end();
    else if (req.url === "/slow") setTimeout(() => res.writeHead(200).end("late"), 500);
    else if (req.url === "/stall") res.writeHead(200).write("x"); // headers and one byte, then nothing
    else if (req.url === "/1024") res.writeHead(200).end("x".repeat(1024));
    else res.writeHead(200).end('{"jobs": []}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  service = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    renders.push(body);
    if (body.url.endsWith("/service-504")) return void res.writeHead(504).end();
    if (body.url.endsWith("/service-502")) return void res.writeHead(502, { "x-error": "TargetClosedError" }).end();
    if (body.url.endsWith("/service-422")) return void res.writeHead(422, { "x-error": "LayoutMissing" }).end();
    if (body.url.endsWith("/service-400")) return void res.writeHead(400).end();
    try {
      const page = await fetch(body.url, { redirect: "manual", signal: AbortSignal.timeout(body.timeoutMs) });
      res.writeHead(200, { "x-upstream-status": String(page.status) }).end(Buffer.from(await page.arrayBuffer()));
    } catch (e) {
      // As the real service: a page that did not settle in time is 504, a failed navigation 502.
      if (!res.headersSent) res.writeHead((e as Error).name === "TimeoutError" ? 504 : 502).end();
    }
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  process.env.BROWSER_URL = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
});
afterAll(async () => {
  delete process.env.BROWSER_URL;
  service.closeAllConnections();
  await new Promise<void>((resolve) => service.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as FetchError;
  }
  throw new Error("expected a FetchError");
};

describe.each(TIERS)("%s fetcher", (tier: Tier) => {
  const policy: FetchPolicy = { maxTier: tier, minIntervalMs: 0, maxRequestsPerRun: 10 };
  it("returns a 200 body with its tier", async () => {
    const r = await createFetcher(policy).get({ url: `${base}/ok`, maxBytes: 100, timeoutMs: 2000 });
    expect([r.status, new TextDecoder().decode(r.body), r.tier]).toEqual([200, '{"jobs": []}', tier]);
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

  it("times out a body that stalls after the headers (code review, step 8c)", async () => {
    const e = await failure(createFetcher(policy).get({ url: `${base}/stall`, maxBytes: 100, timeoutMs: 200 }));
    expect([e.kind, e.transient]).toEqual(["timeout", true]);
  }, 5_000);

  it("serves concurrent calls one at a time, keeping the interval and the cap", async () => {
    let now = 0;
    const waits: number[] = [];
    const clock = { now: () => now, sleep: async (ms: number) => void (waits.push(ms), (now += ms)) };
    const f = createFetcher({ maxTier: tier, minIntervalMs: 3_000, maxRequestsPerRun: 2 }, clock);
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
    const f = createFetcher({ maxTier: tier, minIntervalMs: 3_000, maxRequestsPerRun: 2 }, clock);
    await f.get({ url: `${base}/ok`, maxBytes: 100, timeoutMs: 2000 });
    now += 1_000;
    await f.get({ url: `${base}/ok`, maxBytes: 100, timeoutMs: 2000 });
    const e = await failure(f.get({ url: `${base}/ok`, maxBytes: 100, timeoutMs: 2000 }));
    expect([waits, f.requests, e.kind, e.transient]).toEqual([[2_000], 2, "request_limit", false]);
  });
});

describe("tier choice (plan step 8c)", () => {
  const stub = (status: number, log: string[], name: string): Transport => async (url) => (log.push(name), new Response(status === 200 ? "ok" : null, { status }));
  const req = { url: "https://example.com/jobs", maxBytes: 100, timeoutMs: 2000 };

  it("reads with the source's highest tier only and reports it", async () => {
    const log: string[] = [];
    const f = createFetcher({ maxTier: "browser_like", minIntervalMs: 0, maxRequestsPerRun: 2 }, undefined, { plain: stub(403, log, "plain"), browser_like: stub(200, log, "browser_like"), browser: stub(200, log, "browser") });
    expect([(await f.get(req)).tier, log]).toEqual(["browser_like", ["browser_like"]]);
  });

  it("a source whose highest tier is plain fails when blocked and never moves up a tier", async () => {
    for (const blocked of [403, 0]) {
      const log: string[] = [];
      const reset: Transport = async () => (log.push("plain"), Promise.reject(Object.assign(new Error("reset"), { name: "TypeError" })));
      const f = createFetcher({ maxTier: "plain", minIntervalMs: 0, maxRequestsPerRun: 5 }, undefined, { plain: blocked ? stub(blocked, log, "plain") : reset, browser_like: stub(200, log, "browser_like"), browser: stub(200, log, "browser") });
      const e = await failure(f.get(req));
      expect([e.kind, log, f.requests]).toEqual([blocked ? "http_status" : "network", ["plain"], 1]);
    }
  });
});

describe("browser tier service (plan step 8d)", () => {
  const policy: FetchPolicy = { maxTier: "browser", minIntervalMs: 0, maxRequestsPerRun: 10 };

  it("sends the URL, a smaller timeout and the waitFor selector to the service, and no headers", async () => {
    renders.length = 0;
    await createFetcher(policy).get({ url: `${base}/ok`, maxBytes: 100, timeoutMs: 30_000, waitFor: ".job", headers: { "User-Agent": "x" } });
    expect(renders).toEqual([{ url: `${base}/ok`, timeoutMs: 25_000, waitFor: ".job" }]);
    expect([serviceBudget(2_000), serviceBudget(8_000), serviceBudget(1), serviceBudget(0), serviceBudget(300_000)]).toEqual([1_000, 4_000, 1, 1, 120_000]);
  });

  it("maps the service's 504 to timeout and its other failures to network, both transient", async () => {
    const f = createFetcher(policy);
    const timeout = await failure(f.get({ url: `${base}/service-504`, maxBytes: 100, timeoutMs: 2000 }));
    const broken = await failure(f.get({ url: `${base}/service-502`, maxBytes: 100, timeoutMs: 2000 }));
    expect([timeout.kind, timeout.transient, broken.kind, broken.transient]).toEqual(["timeout", true, "network", true]);
  });

  it("a missing selector and a refused request are browser_tier, not retried (code review round 2)", async () => {
    const f = createFetcher(policy);
    const layout = await failure(f.get({ url: `${base}/service-422`, maxBytes: 100, timeoutMs: 2000 }));
    const refused = await failure(f.get({ url: `${base}/service-400`, maxBytes: 100, timeoutMs: 2000 }));
    expect([layout.kind, layout.transient, refused.kind, refused.transient]).toEqual(["browser_tier", false, "browser_tier", false]);
  });

  it("no service configured, or none listening, is browser_tier, not retried", async () => {
    renders.length = 0;
    const one = (svc: () => string | undefined) => failure(createFetcher(policy, undefined, { plain: browserTier(), browser_like: browserTier(), browser: browserTier(svc) }).get({ url: `${base}/ok`, maxBytes: 100, timeoutMs: 2000 }));
    const missing = await one(() => undefined);
    // A port nothing listens on (port 1 is on fetch's blocked-port list, so it never connects at all).
    const idle = createServer();
    await new Promise<void>((resolve) => idle.listen(0, "127.0.0.1", resolve));
    const port = (idle.address() as AddressInfo).port;
    await new Promise<void>((resolve) => idle.close(() => resolve()));
    const down = await one(() => `http://127.0.0.1:${port}`);
    expect([missing.kind, missing.transient, down.kind, down.transient, renders]).toEqual(["browser_tier", false, "browser_tier", false, []]);
  });
});

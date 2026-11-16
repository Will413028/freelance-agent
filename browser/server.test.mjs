// The service's contract with a stub render (no browser; the real one runs in CI's image job and on the VM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderServer, parseRenderRequest, serial } from "./server.mjs";

async function withServer(render, fn, grace) {
  const server = createRenderServer(render, grace);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}
const post = (base, body) => fetch(`${base}/render`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const ok = { url: "https://example.com/jobs", timeoutMs: 1000 };

test("a rendered page comes back with its upstream status", async () => {
  await withServer(async () => ({ status: 200, html: "<p>jobs</p>" }), async (base) => {
    const r = await post(base, ok);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-upstream-status"), "200");
    assert.equal(await r.text(), "<p>jobs</p>");
  });
});

test("an upstream 403 is passed through as the upstream status, not a service error", async () => {
  await withServer(async () => ({ status: 403, html: "" }), async (base) => {
    const r = await post(base, ok);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-upstream-status"), "403");
  });
});

test("a browser failure is 502 and a timeout 504, named in x-error", async () => {
  const fail = (name) => async () => {
    const e = new Error("x");
    e.name = name;
    throw e;
  };
  await withServer(fail("TypeError"), async (base) => {
    const r = await post(base, ok);
    assert.equal(r.status, 502);
    assert.equal(r.headers.get("x-error"), "TypeError");
  });
  await withServer(fail("RenderTimeout"), async (base) => assert.equal((await post(base, ok)).status, 504));
});

test("bad requests are refused before any render", async () => {
  let calls = 0;
  await withServer(async () => (calls++, { status: 200, html: "" }), async (base) => {
    for (const body of ["nope", { url: "file:///etc/passwd", timeoutMs: 1 }, { url: "https://a.b", timeoutMs: 0 }, { url: "https://a.b", timeoutMs: 999999 }, { ...ok, waitFor: " " }]) {
      assert.equal((await post(base, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await fetch(`${base}/other`)).status, 404);
  });
  assert.equal(calls, 0);
});

test("request headers are not taken (the fingerprint sets them)", () => {
  const { request } = parseRenderRequest(JSON.stringify({ ...ok, headers: { "User-Agent": "x" } }));
  assert.deepEqual(request, { url: ok.url, timeoutMs: 1000, waitFor: null });
});

test("a request whose deadline passed while it waited is 504 without a render (its time counts from arrival)", async () => {
  const seen = [];
  const render = async ({ url }) => {
    seen.push(new URL(url).pathname);
    await new Promise((r) => setTimeout(r, 120));
    return { status: 200, html: "" };
  };
  await withServer(render, async (base) => {
    const first = post(base, { ...ok, url: "https://example.com/slow" });
    await new Promise((r) => setTimeout(r, 10));
    const late = await post(base, { ...ok, url: "https://example.com/late", timeoutMs: 50 });
    assert.equal(late.status, 504);
    await first;
  });
  assert.deepEqual(seen, ["/slow"]);
});

test("the service gives each render its deadline from arrival", async () => {
  let got;
  await withServer(async (r) => ((got = r), { status: 200, html: "" }), async (base) => {
    const before = Date.now();
    await post(base, { ...ok, timeoutMs: 5000 });
    assert.ok(got.deadline >= before + 5000 && got.deadline <= Date.now() + 5000);
  });
});

test("a waitFor selector that never appears is 422", async () => {
  const layout = async () => {
    const e = new Error("x");
    e.name = "LayoutMissing";
    throw e;
  };
  await withServer(layout, async (base) => assert.equal((await post(base, ok)).status, 422));
});

test("a render whose caller left before its turn is skipped", async () => {
  const seen = [];
  let release;
  const render = async ({ url }) => {
    seen.push(new URL(url).pathname);
    if (seen.length === 1) await new Promise((r) => (release = r));
    return { status: 200, html: "" };
  };
  await withServer(render, async (base) => {
    const first = post(base, { ...ok, url: "https://example.com/first" });
    await new Promise((r) => setTimeout(r, 20));
    const gone = new AbortController();
    const second = fetch(`${base}/render`, { method: "POST", body: JSON.stringify({ ...ok, url: "https://example.com/gone" }), signal: gone.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 20));
    gone.abort();
    await second;
    await new Promise((r) => setTimeout(r, 20));
    release();
    await first;
    await post(base, { ...ok, url: "https://example.com/third" });
  });
  assert.deepEqual(seen, ["/first", "/third"]);
});

test("renders run one at a time, also when calls arrive while others run (code review round 2)", async () => {
  let running = 0, peak = 0;
  const one = serial(async () => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 30));
    running--;
  });
  const arg = () => ({ deadline: Date.now() + 10_000 });
  const calls = [one(arg()), one(arg()), one(arg())];
  await new Promise((r) => setTimeout(r, 45)); // the second render is running
  calls.push(one(arg()), one(arg()));
  await Promise.all(calls);
  assert.equal(peak, 1);
});

test("healthz answers ok", async () => {
  await withServer(async () => ({ status: 200, html: "" }), async (base) => assert.equal(await (await fetch(`${base}/healthz`)).text(), "ok"));
});

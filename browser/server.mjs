// Tier 3 (`browser`) of the tiered reading (plan step 8d, D4: Crawlee with Playwright Chromium, the setup
// spikes.md §2 measured from the VM). The daily run never loads a browser: its fetcher POSTs one URL here
// and gets the rendered page back. The service is reachable only on the compose network (no published
// port) and is started with the daily run and stopped after it (deploy/compose.yaml, systemd unit).
//
//   POST /render  {"url": "https://…", "timeoutMs": 25000, "waitFor": "css selector"}
//     200 with `x-upstream-status: <status of the page's first response>` and the HTML as the body;
//         a redirect is reported as its own 3xx status (redirects are never followed as a success)
//     400 bad request, 422 the waitFor selector never appeared, 502 the browser failed (`x-error: <error
//     name>`), 504 the page did not settle before the deadline (timeoutMs from the request's arrival)
//   GET /healthz  200 "ok"
//
// One page at a time (memory: one Chromium peaked at 484 MiB on the VM; the limit is 1 GB). Each render is its own
// PlaywrightCrawler run with no retries and no stored state, so nothing carries over between sources.
// No request headers are taken: Crawlee's generated fingerprint sets them consistently, a replaced
// User-Agent is what fingerprint checks look for, and Chromium would send extra headers to every
// third-party host the page loads (code review, step 8d). timeoutMs bounds the whole render, browser
// launch included; the caller gives it less than its own timeout so the 504 reaches it.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 3100);
const MAX_TIMEOUT_MS = 120_000;
const MAX_BODY = 64 * 1024;

/** Validates a /render body; returns the request or a message saying why it is refused. */
export function parseRenderRequest(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: "body is not JSON" };
  }
  if (typeof body !== "object" || body === null) return { error: "body is not an object" };
  const { url, timeoutMs, waitFor = null } = body;
  if (typeof url !== "string" || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return { error: "url must be http(s)" };
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) return { error: `timeoutMs must be 1..${MAX_TIMEOUT_MS}` };
  if (waitFor !== null && (typeof waitFor !== "string" || !waitFor.trim())) return { error: "waitFor must be a selector" };
  return { request: { url, timeoutMs, waitFor } };
}

export class RenderTimeout extends Error {
  name = "RenderTimeout";
}
/** The page loaded but the waitFor selector never appeared: its layout changed, retrying will not help. */
export class LayoutMissing extends Error {
  name = "LayoutMissing";
}

/**
 * Runs renders one after another in arrival order: the next starts only after the previous render has
 * really finished (render() closes its browser by its own deadline, render.mjs). A request whose deadline
 * passed while it waited, or whose caller left, is skipped without opening a browser.
 */
export function serial(fn) {
  let queue = Promise.resolve();
  return (arg, signal) => {
    const run = queue.then(() => {
      if (signal?.aborted) throw new RenderTimeout("caller gone before its turn");
      if (Date.now() >= arg.deadline) throw new RenderTimeout("deadline passed in the queue");
      return fn(arg);
    });
    queue = run.catch(() => undefined);
    return run;
  };
}

const STATUS_OF = { RenderTimeout: 504, LayoutMissing: 422 };

// Loaded on first render, so the tests (stub render) need neither Crawlee nor a browser installed.
const crawleeRender = (request) => import("./render.mjs").then((m) => m.render(request));

export function createRenderServer(render = crawleeRender) {
  const one = serial(render);
  return createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") return void res.writeHead(200).end("ok");
    if (req.method !== "POST" || req.url !== "/render") return void res.writeHead(404).end();
    const arrived = Date.now();
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (text.length > MAX_BODY) return void res.writeHead(413).end();
    }
    const parsed = parseRenderRequest(text);
    if (parsed.error) return void res.writeHead(400, { "content-type": "text/plain" }).end(parsed.error);
    const id = randomUUID();
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    try {
      const { status, html } = await one({ ...parsed.request, id, deadline: arrived + parsed.request.timeoutMs }, gone.signal);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-upstream-status": String(status) }).end(html);
    } catch (e) {
      const name = e?.name ?? "Error";
      // Only the error name and host are logged: never page content (AGENTS.md).
      console.error(`render ${id} ${new URL(parsed.request.url).host}: ${name}`);
      if (!res.headersSent) res.writeHead(STATUS_OF[name] ?? 502, { "x-error": name.replace(/[^\w.-]/g, "") }).end();
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createRenderServer();
  server.listen(PORT, "0.0.0.0", () => console.log(`browser tier listening on ${PORT}`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

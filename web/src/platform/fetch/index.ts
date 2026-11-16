// Tiered reading (plan step 4; tier 2 in step 8c, tier 3 in 8d): a source reads through one Fetcher made
// from its source settings, every request at the source's highest tier. Tier 1 (`plain`) is Node's fetch;
// tier 2 (`browser_like`) sends the same GET with a browser's TLS and HTTP/2 fingerprint through impit,
// the HTTP client Crawlee (plan D4) uses; tier 3 (`browser`) asks the browser service (`browser/`, a
// separate image started with the daily run, plan step 8d) to render the page in Chromium through Crawlee
// and reads back the HTML and the status of the page's first response. All tiers keep the same rules: no redirects, a timeout over the whole
// request, a size cap, a minimum interval between this source's requests and a cap on its requests per run.
// No tier is tried and abandoned on the way up: a source needing tier 2 is blocked at tier 1 every time
// (spikes.md §2 measured each source's lowest working tier), so starting low would only spend a request,
// and a source blocked at its highest tier fails (plan step 8: no proxies, no CAPTCHA solving).
// One daily run per Taipei day (runs table), so the per-run cap is the daily cap for scheduled runs; a
// manual run-source.ts adds at most one more run's worth, by hand.

import type { Impit } from "impit";

/** The reading tiers in order, named as run_sources.tier stores them. */
export const TIERS = ["plain", "browser_like", "browser"] as const;
export type Tier = (typeof TIERS)[number];

export type FetchPolicy = {
  /** The highest tier this source may use; every request of the source is sent at it. */
  maxTier: Tier;
  /** Minimum time between the starts of two requests of this source. */
  minIntervalMs: number;
  /** Requests this source may send in one run. */
  maxRequestsPerRun: number;
};

export type FetchRequest = {
  url: string;
  headers?: Record<string, string>;
  maxBytes: number;
  timeoutMs: number;
  /** Tier 3 only: a CSS selector the rendered page must show before it is read (other tiers ignore it). */
  waitFor?: string;
};
export type FetchResponse = { status: number; body: Uint8Array; tier: Tier };

/**
 * Why a read failed; step 6 retries the transient kinds (network, timeout, HTTP 429 and 5xx).
 * browser_tier (step 8d) is a lasting tier-3 failure a retry cannot fix: no service configured or
 * reachable, a request the service refuses, or a page whose waitFor selector never appeared (layout changed).
 */
export type FetchErrorKind = "invalid_url" | "network" | "timeout" | "http_status" | "too_large" | "request_limit" | "browser_tier";

export class FetchError extends Error {
  constructor(readonly kind: FetchErrorKind, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "FetchError";
  }

  get transient(): boolean {
    return this.kind === "network" || this.kind === "timeout" || (this.kind === "http_status" && (this.status === 429 || this.status! >= 500));
  }
}

export type Fetcher = { get(req: FetchRequest): Promise<FetchResponse>; readonly requests: number };

/** One GET at a tier; redirects are never followed and the signal bounds the whole request. */
export type Transport = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; timeoutMs: number; waitFor?: string }) => Promise<TransportResponse>;
type TransportResponse = { status: number; body: ReadableStream<Uint8Array> | null };

// Firefox, not Chrome: on 2026-11-17 Remote.co's Akamai answered impit's Chrome fingerprint with its
// challenge page and its Firefox one with the jobs (curl_cffi's Chrome passed; same machine and hour).
// The impit sent with our own User-Agent header, which overrides the fingerprint's: Akamai passed it the
// same day (measured), so the source still says who it is. Loaded on first use, so code that only needs
// FetchError or the types (the web app's routes) never loads impit's native addon.
let impit: Promise<Impit> | null = null;
const browserLike: Transport = async (url, { headers, signal }) => {
  impit ??= import("impit").then(({ Impit }) => new Impit({ browser: "firefox", followRedirects: false }));
  return (await impit).fetch(url, { headers, signal });
};
const plain: Transport = (url, { headers, signal }) => fetch(url, { headers, signal, redirect: "manual" });

/** The service's own limit on a render (browser/server.mjs MAX_TIMEOUT_MS). */
const SERVICE_MAX_MS = 120_000;
/**
 * The service's budget: 5 s under this request's own timeout (at least half of it), so the service's 504
 * arrives before the signal fires; always within 1 ms..SERVICE_MAX_MS so the service never refuses it.
 */
export const serviceBudget = (timeoutMs: number) => Math.min(SERVICE_MAX_MS, Math.max(1, Math.floor(timeoutMs / 2), timeoutMs - 5_000));
// A service that does not answer at all (no such host, nothing listening): it was not started or has
// died, and nothing restarts it within the run.
const UNREACHABLE = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);

/**
 * Tier 3: one POST to the browser service (contract in browser/server.mjs). The page's own status comes
 * back in x-upstream-status, so a blocked page is an http_status failure like on the other tiers. The
 * service's 504 is a timeout and its 5xx a network failure (both transient); a missing or unreachable
 * service, a refused request (4xx) and a missing waitFor selector (422) are browser_tier (not retried).
 * BROWSER_URL is set for the daily service only (deploy/compose.yaml). No headers are sent: the
 * fingerprint sets them (browser/server.mjs).
 */
export const browserTier = (service: () => string | undefined = () => process.env.BROWSER_URL): Transport => async (url, { signal, timeoutMs, waitFor }) => {
  const base = service();
  if (!base) throw new FetchError("browser_tier", "BROWSER_URL is not set");
  let r: Response;
  try {
    r = await fetch(`${base}/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, timeoutMs: serviceBudget(timeoutMs), waitFor: waitFor ?? null }),
      signal,
      redirect: "manual",
    });
  } catch (e) {
    const code = ((e as Error).cause as { code?: string } | undefined)?.code;
    if (code && UNREACHABLE.has(code)) throw new FetchError("browser_tier", `browser service unreachable (${code})`);
    throw e;
  }
  const upstream = Number(r.headers.get("x-upstream-status"));
  if (r.status !== 200 || !Number.isInteger(upstream) || upstream < 100) {
    await r.body?.cancel();
    if (r.status === 504) throw new FetchError("timeout", "browser tier timed out");
    if (r.status === 422) throw new FetchError("browser_tier", "waitFor selector never appeared (layout changed?)", 422);
    if (r.status >= 400 && r.status < 500) throw new FetchError("browser_tier", `browser service refused the request (${r.status})`, r.status);
    throw new FetchError("network", `browser service answered ${r.status}`);
  }
  return { status: upstream, body: r.body };
};
const TRANSPORTS: Record<Tier, Transport> = { plain, browser_like: browserLike, browser: browserTier() };

type Clock = { now(): number; sleep(ms: number): Promise<void> };
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Reads the body up to maxBytes + 1 so a body of exactly the cap passes and one byte more fails. */
async function readCapped(response: TransportResponse, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new FetchError("too_large", `body over ${maxBytes} bytes`);
      }
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) body.set(c, offset), (offset += c.length);
  return body;
}

/**
 * A failure by kind. A request whose timeout signal fired is a timeout whatever the transport threw: impit
 * reports a body cut off by the signal as its own error class. Impit's own timeout classes (ConnectTimeout,
 * ReadTimeout, ...) end in "Timeout".
 */
const failure = (e: unknown, host: string, signal: AbortSignal) => {
  if (e instanceof FetchError) return e;
  const name = (e as Error).name;
  const timedOut = signal.aborted || name === "TimeoutError" || name === "AbortError" || name.endsWith("Timeout");
  return new FetchError(timedOut ? "timeout" : "network", `${name} reading ${host}`);
};

/**
 * A Fetcher for one source and one run. Any status but 200 is an http_status error; redirects are not
 * followed. Calls are served one at a time in call order, so concurrent calls keep the interval and the cap.
 */
export function createFetcher(policy: FetchPolicy, clock: Clock = realClock, transports: Record<Tier, Transport> = TRANSPORTS): Fetcher {
  const tier = policy.maxTier, transport = transports[tier];
  let requests = 0, lastStart: number | null = null, queue: Promise<unknown> = Promise.resolve();
  async function one({ url, headers = {}, maxBytes, timeoutMs, waitFor }: FetchRequest): Promise<FetchResponse> {
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw new FetchError("invalid_url", "not an http(s) URL");
    const host = new URL(url).host;
    if (requests >= policy.maxRequestsPerRun) throw new FetchError("request_limit", `over ${policy.maxRequestsPerRun} requests this run`);
    if (lastStart !== null) {
      const wait = lastStart + policy.minIntervalMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
    }
    requests++;
    lastStart = clock.now();
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await transport(url, { headers, signal, timeoutMs, waitFor });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new FetchError("http_status", `HTTP ${response.status} from ${host}`, response.status);
      }
      return { status: response.status, body: await readCapped(response, maxBytes), tier };
    } catch (e) {
      throw failure(e, host, signal);
    }
  }
  return {
    get requests() {
      return requests;
    },
    get(req) {
      const run = queue.then(() => one(req));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

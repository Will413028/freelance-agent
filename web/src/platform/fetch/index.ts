// Tiered reading (plan step 4; tier 2 in step 8c, tier 3 in 8d): a source reads through one Fetcher made
// from its source settings, every request at the source's highest tier. Tier 1 (`plain`) is Node's fetch;
// tier 2 (`browser_like`) sends the same GET with a browser's TLS and HTTP/2 fingerprint through impit,
// the HTTP client Crawlee (plan D4) uses. Both keep the same rules: no redirects, a timeout over the whole
// request, a size cap, a minimum interval between this source's requests and a cap on its requests per run.
// No tier is tried and abandoned on the way up: a source needing tier 2 is blocked at tier 1 every time
// (spikes.md §2 measured each source's lowest working tier), so starting low would only spend a request,
// and a source blocked at its highest tier fails (plan step 8: no proxies, no CAPTCHA solving).
// One daily run per Taipei day (runs table), so the per-run cap is the daily cap for scheduled runs; a
// manual run-source.ts adds at most one more run's worth, by hand.

import type { Impit } from "impit";

/** The reading tiers in order, named as run_sources.tier stores them; step 8d adds "browser". */
export const TIERS = ["plain", "browser_like"] as const;
export type Tier = (typeof TIERS)[number];

export type FetchPolicy = {
  /** The highest tier this source may use; every request of the source is sent at it. */
  maxTier: Tier;
  /** Minimum time between the starts of two requests of this source. */
  minIntervalMs: number;
  /** Requests this source may send in one run. */
  maxRequestsPerRun: number;
};

export type FetchRequest = { url: string; headers?: Record<string, string>; maxBytes: number; timeoutMs: number };
export type FetchResponse = { status: number; body: Uint8Array; tier: Tier };

/** Why a read failed; step 6 retries the transient kinds (network, timeout, HTTP 429 and 5xx). */
export type FetchErrorKind = "invalid_url" | "network" | "timeout" | "http_status" | "too_large" | "request_limit";

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
export type Transport = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<TransportResponse>;
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
const TRANSPORTS: Record<Tier, Transport> = { plain, browser_like: browserLike };

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
  async function one({ url, headers = {}, maxBytes, timeoutMs }: FetchRequest): Promise<FetchResponse> {
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
      const response = await transport(url, { headers, signal });
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

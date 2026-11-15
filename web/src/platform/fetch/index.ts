// Tiered reading (plan step 4; tiers 2 and 3 come in step 8): a source reads through one Fetcher made
// from its source settings. Tier 1 is a plain GET: no redirects, a timeout over the whole request, a
// size cap, a minimum interval between this source's requests and a cap on its requests per run.
// One daily run per Taipei day (runs table), so the per-run cap is the daily cap for scheduled runs; a
// manual run-source.ts adds at most one more run's worth, by hand.

/** The reading tier, named as run_sources.tier stores it; step 8 adds "browser_like" and "browser". */
export type Tier = "plain";

export type FetchPolicy = {
  /** The highest tier this source may use. */
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

type Clock = { now(): number; sleep(ms: number): Promise<void> };
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Reads the body up to maxBytes + 1 so a body of exactly the cap passes and one byte more fails. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
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

const failure = (e: unknown, host: string) => {
  if (e instanceof FetchError) return e;
  const name = (e as Error).name;
  return new FetchError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", `${name} reading ${host}`);
};

/**
 * A Fetcher for one source and one run. Any status but 200 is an http_status error; redirects are not
 * followed. Calls are served one at a time in call order, so concurrent calls keep the interval and the cap.
 */
export function createFetcher(policy: FetchPolicy, clock: Clock = realClock, transport: typeof fetch = fetch): Fetcher {
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
    try {
      const response = await transport(url, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new FetchError("http_status", `HTTP ${response.status} from ${host}`, response.status);
      }
      return { status: response.status, body: await readCapped(response, maxBytes), tier: "plain" };
    } catch (e) {
      throw failure(e, host);
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

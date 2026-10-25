import { HttpError, raiseForUrllibStatus, urlopenRead } from "@/platform/http";
import { pyIsInstance } from "@/platform/errors";
import { decodeStrict } from "@/platform/py/codecs";
import { PyDateTime } from "@/platform/py/datetime";
import { htmlFeed } from "@/platform/py/html";
import { loads } from "@/platform/py/json";
import { pyFullmatch, pyRe } from "@/platform/py/re";
import { urljoin, urlsplit, urlunsplit } from "@/platform/py/url";
import { isDict, PyDict, PyError, pyGet, type PyValue } from "@/platform/py/value";

// What the public-page sources of plan step 8, batch 3 (nodesk, justremote, dynamitejobs, jobbank518,
// chickpt) share in Python: nodesk.Metadata, the read() each fetch() defines (urllib with
// public_feeds.NoRedirect, then ptt_soho.read_body), the access-challenge check and the
// JobPosting employment mapping. Sources import this, never each other.

export const USER_AGENT = "freelance-agent/0.1 personal-job-discovery";
export const PAGE_LIMIT = 2_000_000;
/** The whole-source time budget every one of these fetch() functions starts with. */
export const SOURCE_BUDGET_MS = 90_000;

/** One GET: the URL and the time left on the source deadline. */
export type Get = (url: string, remainingMs: number) => Promise<{ status: number; body: Uint8Array }>;

// urlopen(timeout=min(10, remaining)), then read_body: 8 s per chunk within the source deadline. Python
// sends Accept-Encoding: identity because urllib cannot decompress; fetch negotiates compression and
// decompresses, and the 2 MB cap still counts the page itself, so the header is not sent.
export const httpGet: Get = (url, remainingMs) => urlopenRead(url, { "User-Agent": USER_AGENT }, PAGE_LIMIT, 10_000, 8_000, remainingMs);

/** The test seams of the batch-3 fetch() functions; production uses the defaults. */
export type FetchSeams = {
  request?: Get;
  pause?: (ms: number) => Promise<unknown>;
  /** time.monotonic in milliseconds */
  monotonic?: () => number;
  /** datetime.now(timezone.utc) */
  now?: () => PyDateTime;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const seams = (s: FetchSeams) => ({
  request: s.request ?? httpGet, pause: s.pause ?? sleep, monotonic: s.monotonic ?? (() => performance.now()), now: s.now ?? (() => PyDateTime.now()),
});

/**
 * The read(url) inside each fetch(), minus its canonical() check: TimeoutError once the deadline has
 * passed; urllib's status semantics (raiseForUrllibStatus), then the source's own ValueError for another
 * 2xx; read_body's 2 MB and deadline checks. A network failure is an OSError, like URLError.
 */
export function pageReader(request: Get, monotonic: () => number, deadline: number) {
  return async (url: string): Promise<Uint8Array> => {
    const remaining = deadline - monotonic();
    if (remaining <= 0) throw new PyError("TimeoutError", "Source deadline");
    let r: { status: number; body: Uint8Array };
    try {
      r = await request(url, remaining);
    } catch (e) {
      if (e instanceof PyError) throw e;
      throw new PyError("OSError", (e as Error).message);
    }
    raiseForUrllibStatus(r.status);
    if (r.status !== 200) throw new PyError("ValueError", "Source unavailable");
    if (r.body.length > PAGE_LIMIT) throw new PyError("ValueError", "Response limit");
    if (monotonic() > deadline) throw new PyError("ValueError", "Source time budget exceeded");
    return r.body;
  };
}

/** HTMLParser attrs as dict(attrs).get(name, fallback): the last duplicate wins, a bare name is None. */
export function attr(attrs: [string, string | null][], name: string, fallback: string | null | undefined = undefined): string | null | undefined {
  let value: string | null | undefined = fallback;
  for (const [k, v] of attrs) if (k === name) value = v;
  return value;
}

/** nodesk.Metadata: the JobPosting objects of the page's application/ld+json scripts; bad JSON there fails the page. */
export function jobPostings(html: string): PyDict[] {
  let active = false, parts: string[] = [];
  const jobs: PyDict[] = [];
  htmlFeed(html, {
    starttag(tag, attrs) {
      if (tag === "script" && attr(attrs, "type") === "application/ld+json") active = true, (parts = []);
    },
    data(data) {
      if (active) parts.push(data);
    },
    endtag(tag) {
      if (tag === "script" && active) {
        active = false;
        const value = loads(parts.join(""));
        if (isDict(value) && pyGet(value, "@type") === "JobPosting") jobs.push(value);
      }
    },
  }, true);
  return jobs;
}

/** The kind every batch-3 JobPosting source derives from employmentType. */
export const kindOf = (types: string[]) =>
  types.includes("FULL_TIME") ? "full_time" : types.some((t) => t === "PART_TIME" || t === "CONTRACTOR" || t === "TEMPORARY") ? "contract" : null;

/** employmentType as the sources accept it: a str becomes [str]; otherwise a list of str (non-empty when `nonEmpty`). */
export function employmentTypes(value: PyValue, nonEmpty: boolean): string[] {
  const types = typeof value === "string" ? [value] : value;
  if (!Array.isArray(types) || (nonEmpty && !types.length) || types.some((t) => typeof t !== "string")) throw new PyError("ValueError", "Invalid employment types");
  return types as string[];
}

const CHALLENGE = pyRe(String.raw`cf-chl-|_Incapsula_Resource|captcha-container|<title>\s*(?:Just a moment|Access denied)`, true);
/** Every regex in this file, for the golden test. */
export const regexes = () => ({ CHALLENGE });

/** page_text (dynamitejobs, jobbank518; inlined in chickpt.parse_page): size, strict UTF-8, access challenge. */
export function pageText(raw: Uint8Array): string {
  if (!raw.length || raw.length > PAGE_LIMIT) throw new PyError("ValueError", "Invalid page size");
  const html = decodeStrict("utf-8", raw);
  if (CHALLENGE.test(html)) throw new PyError("AccessBlocked", "Access challenge");
  return html;
}

/**
 * The canonical(value) of the HTML sources: urljoin onto the origin, https on the exact host, the
 * article path pattern (fullmatch), and the query and fragment dropped.
 */
export function canonicalOn(origin: string, host: string, article: string, value: PyValue | undefined): string {
  if (typeof value !== "string") throw new PyError("ValueError", "Missing job URL");
  const url = urlsplit(urljoin(origin, value));
  if (url.scheme !== "https" || url.netloc !== host || !pyFullmatch(article, url.path)) throw new PyError("ValueError", "Invalid job URL");
  return urlunsplit({ ...url, query: "", fragment: "" });
}

/**
 * How dynamitejobs, jobbank518 and chickpt treat a failed detail page: an access challenge or a
 * 401/403/429 stops the whole fetch, other listed classes reject that page, anything else propagates.
 */
export function rejectsDetail(e: unknown, ...types: string[]): boolean {
  if (pyIsInstance(e, "AccessBlocked")) return false;
  if (e instanceof HttpError) return ![401, 403, 429].includes(e.code);
  return pyIsInstance(e, ...types);
}

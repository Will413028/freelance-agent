import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type SourceSettings } from "../types";
import { codePoints, isObject as isRecord, truthy } from "../shared/json";

// Freelancer: the public official active-project search, three fixed queries, paginated; never bids
// (old collection/freelancer.py, web/src/modules/collection/sources/freelancer.ts at ce1254d).
//
// A project the old connector refused (rejected_count, which turned the run partial) is still set
// aside and counted in `rejected` when the refusal was about identity or about what the source's own
// rules read: id, status/deleted/nonpublic, title, description, the project's own URL (Will
// 2026-11-15; more than half set aside fails the source). A refusal about any other field is
// unknown now (plan D8): update time, project type, currency and budget become null. The source's
// own rule (sourceKept) keeps titles that name the work this tool looks for and drops out-of-scope
// titles; every project read is stored with that mark (plan D9).

export const QUERIES = ["AI agent", "API integration", "MVP web development"] as const;
const API = "https://www.freelancer.com/api/projects/0.1/projects/active/";
/** Per page the old sync asked for (old freelancer.ts:152) and the pages per query (old :77). */
export const PAGE_LIMIT = 100;
export const MAX_PAGES = 20;
const MAX_BYTES = 2_000_000;

// The old Python patterns ran with re.IGNORECASE on str, so \b is a Unicode word boundary: Python's
// \w is a letter, a digit or '_' in any script. JavaScript's \b is ASCII-only, so the boundary is
// spelled with Unicode lookarounds, and "." (any but a newline in Python) is [^\n]; the golden b4_re cases check both patterns.
const W = String.raw`[\p{L}\p{N}_]`;
const word = (body: string) => new RegExp(String.raw`(?<!${W})(?:${body})(?!${W})`, "iu");
const TITLE_SIGNAL = word(String.raw`ai|agent|api|backend|back[^\n]end|full[^\n]stack|mvp|website|web\s+app|web\s+development|software\s+development|app\s+development|automation|integration|chatbot|bot`);
const OUT_OF_SCOPE = word(String.raw`copywriting|seo|link\s+building|lead\s+generation|sales|commission|testing|vapt|scraping|data\s+entry|logo|graphic\s+design`);

/** A budget bound: a non-negative number JavaScript holds exactly (past 2^53 two different bounds can read as one). */
const amount = (v: unknown) => (typeof v === "number" && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : null);

/** time_updated (Unix seconds) as an RFC 3339 instant, or null when it is not a positive time in years 1–9999. */
function updatedAt(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const d = new Date(v * 1000);
  return Number.isFinite(d.getTime()) && d.getUTCFullYear() <= 9999 ? d.toISOString() : null;
}

/** One project in the contract; throws SourceError when its identity or status is missing or not active and public (`setAside` sets that one listing aside). */
export function normalize(item: unknown): ListingInput {
  if (!isRecord(item)) throw new SourceError("freelancer: a project is not an object");
  const p = item;
  if (typeof p.id !== "number" || !Number.isSafeInteger(p.id) || p.id <= 0) throw new SourceError("freelancer: invalid id");
  if (p.status !== "active" || truthy(p.deleted) || truthy(p.nonpublic)) throw new SourceError("freelancer: non-public or inactive project");
  const { title, description } = p;
  if (typeof title !== "string" || codePoints(title) < 1 || codePoints(title) > 500) throw new SourceError("freelancer: invalid title");
  if (typeof description !== "string" || codePoints(description) < 1 || codePoints(description) > 50_000) throw new SourceError("freelancer: full description required");
  const slug = p.seo_url;
  if (typeof slug !== "string" || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(slug)) throw new SourceError("freelancer: invalid project URL");
  const url = `https://www.freelancer.com/projects/${slug}`;
  // Currency and budget: the old rules refused the project; now each part it cannot read is unknown,
  // and an unreadable or inverted range makes both bounds unknown.
  const code = isRecord(p.currency) ? p.currency.code : undefined;
  const currency = typeof code === "string" && /^[A-Z]{3}$/.test(code) ? code : null;
  const budget = p.budget === undefined ? {} : isRecord(p.budget) ? p.budget : null;
  let low = budget === null ? null : amount(budget.minimum), high = budget === null ? null : amount(budget.maximum);
  const unreadable = budget === null || [budget.minimum, budget.maximum].some((v) => v !== undefined && v !== null && amount(v) === null);
  if (unreadable || (low !== null && high !== null && low > high)) low = high = null;
  const type = p.type === "fixed" || p.type === "hourly" ? p.type : null;
  return parseListingInput({
    external_id: String(p.id), title, description, url, canonical_url: url,
    kind: type, currency,
    budget_min: low, budget_max: high, complete: false,
    // time_updated is the project's last update, not its publication; it is kept for audit only.
    extra: { time_updated: updatedAt(p.time_updated), project_type: typeof p.type === "string" ? p.type : null },
  });
}

const enc = (q: Record<string, string>) => new URLSearchParams(q).toString();
export const pageUrl = (query: string, limit: number, offset: number) => `${API}?${enc({ query, limit: String(limit), offset: String(offset), full_description: "true" })}`;

function page(body: Uint8Array, limit: number): { projects: unknown[]; total: number } {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SourceError("freelancer: response is not JSON");
  }
  if (!isRecord(data) || data.status !== "success" || !isRecord(data.result)) throw new SourceError("freelancer: response is not a success");
  const { projects, total_count: total } = data.result;
  if (!Array.isArray(projects) || projects.length > limit || typeof total !== "number" || !Number.isSafeInteger(total) || total < projects.length) {
    throw new SourceError("freelancer: unsupported result list");
  }
  return { projects, total };
}

const timeOf = (l: ListingInput) => (l.extra.time_updated as string | null) ?? null;

/**
 * One query's active projects, page by page (old search): the offset advances by the requested page
 * even when the API returns fewer rows; it stops at the reported total, at an empty page, or at a
 * page that brings no new project. A project listed twice keeps its latest update; two different
 * versions with the same update time refuse the batch.
 */
export async function searchQuery(fetcher: Fetcher, query: string, limit = PAGE_LIMIT, maxPages = MAX_PAGES): Promise<{ listings: ListingInput[]; limited: boolean; rejected: number; examined: number }> {
  const jobs = new Map<string, ListingInput>();
  // Old `limited` (freelancer.ts:126-131): true unless the offset reached the reported total with as many distinct projects.
  let limited = true, rejected = 0, examined = 0;
  for (let n = 0, offset = 0; n < maxPages; n++) {
    const r = await fetcher.get({
      url: pageUrl(query, limit, offset), maxBytes: MAX_BYTES, timeoutMs: 20_000,
      headers: { "User-Agent": "side-income/0.1 personal-job-discovery", Accept: "application/json" },
    });
    const { projects, total } = page(r.body, limit);
    // Old freelancer.ts:106-114: a project that fails to normalize is set aside and counted.
    const page_ = setAside(projects, (p) => normalize(p));
    const listings = page_.listings;
    rejected += page_.rejected;
    examined += page_.examined;
    let newIds = 0;
    for (const job of listings) {
      const prior = jobs.get(job.external_id);
      if (prior === undefined) newIds++;
      else if (timeOf(prior) === timeOf(job) && JSON.stringify(prior) !== JSON.stringify(job)) throw new SourceError("freelancer: conflicting project version");
      if (prior === undefined || (timeOf(job) ?? "") > (timeOf(prior) ?? "")) jobs.set(job.external_id, job);
    }
    offset += limit;
    if (offset >= total) {
      limited = jobs.size < total;
      break;
    }
    // Old :132: a page whose projects were all set aside does not stop the query.
    if (!projects.length || (listings.length && !newIds)) break;
  }
  return { listings: [...jobs.values()], limited, rejected, examined };
}

// Python's re.IGNORECASE also lets U+0130 and U+0131 (dotted capital and dotless small i) match "i";
// JavaScript's simple case folding does not, so they read as "i" before matching (one code unit each).
const asPythonCase = (s: string) => s.replace(/[\u0130\u0131]/g, "i");
export const titleSignal = (title: string) => TITLE_SIGNAL.test(asPythonCase(title));
export const outOfScope = (title: string) => OUT_OF_SCOPE.test(asPythonCase(title));
export const titleKept = (title: string) => titleSignal(title) && !outOfScope(title);

/** The source's own rule (old freelancer.ts:162-164): title signals and not out of scope. The old `score > 0` is the shared screen's: evaluate excludes category score 0. */
export const kept = (l: ListingInput) => titleKept(l.title);

export async function freelancerConnector(fetcher: Fetcher): Promise<Collected> {
  const jobs = new Map<string, ListingInput>();
  let truncated = false, rejected = 0, examined = 0;
  for (const query of QUERIES) {
    const result = await searchQuery(fetcher, query);
    truncated ||= result.limited;
    rejected += result.rejected;
    examined += result.examined;
    for (const job of result.listings) {
      const prior = jobs.get(job.external_id);
      if (prior === undefined || (timeOf(job) ?? "") > (timeOf(prior) ?? "")) jobs.set(job.external_id, job);
    }
  }
  // seen: the distinct projects read (old freelancer.ts seen); examined: every project entry checked, per page per query, like rejected.
  return { seen: jobs.size, listings: [...jobs.values()], sourceKept: kept, truncated, rejected, examined };
}

/**
 * Three queries of at most 20 pages each (old freelancer.ts:77 maxPages=20, :150 three QUERIES) is at
 * most 60 requests. The old connector paused 600 ms between pages and queries (:90, :151); the
 * Fetcher's floor is 1000 ms. The old 30 s per query (:77 maxSeconds) only stopped paging early and
 * is not carried over: the page cap bounds what is read, and a query of 20 pages one second apart
 * needs about 20 s plus the answers.
 */
export const FREELANCER_SETTINGS: Omit<SourceSettings, "order"> = {
  label: "Freelancer", name: "freelancer", connector: freelancerConnector, maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: QUERIES.length * MAX_PAGES, completeRead: false, disabled: null,
};

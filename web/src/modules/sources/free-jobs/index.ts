import { z } from "zod";
import { parseJobInput, type JobInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { htmlText } from "../shared/html";
import { setAside } from "../shared/set-aside";
import { utcInstant } from "../shared/time";
import { SourceError, type Collected } from "../types";
import { codePoints } from "../shared/json";

// jobicy and remotive: public JSON APIs with the latest listings (old collection/free_jobs.py,
// web/src/modules/collection/sources/free-jobs.ts at ce1254d). A listing without its identity
// (id, title, description, the board's own URL) or with employment types that are not a list of text
// (the source's own rule reads them: unreadable types would keep nothing) is set aside and counted in
// `rejected`; more than half set aside fails the source (services/collect, Will 2026-11-15; the old
// reader refused the batch for one listing). A feed that is not JSON or has no list refuses the batch.
// Any other field the connector cannot read is unknown
// (plan D8). The source's own rule (sourceKept) keeps contract, part-time and freelance listings.

export const FREE_JOB_SOURCES = ["remotive", "jobicy"] as const;
export type FreeJobSource = (typeof FREE_JOB_SOURCES)[number];

export const ENDPOINTS: Record<FreeJobSource, string> = {
  remotive: "https://remotive.com/api/remote-jobs?category=software-dev&limit=200",
  jobicy: "https://jobicy.com/api/v2/remote-jobs?count=200",
};

const FIELDS = {
  remotive: { title: "title", description: "description", types: "job_type", geo: "candidate_required_location", published: "publication_date", path: "/remote-jobs/" },
  jobicy: { title: "jobTitle", description: "jobDescription", types: "jobType", geo: "jobGeo", published: "pubDate", path: "/jobs/" },
} as const;

/** Generic labels of a country or region exclude Taiwan; "worldwide" and the like do not establish eligibility. */
const EXCLUDED_GEO = new Set(["usa", "us", "united states", "uk", "united kingdom", "canada", "europe", "eu", "australia"]);

const feedSchema = z.object({ jobs: z.array(z.unknown()).max(200) });

/** The source's own types, normalized: lower case, `-` and spaces as `_`; null when the field is not a list of text. */
function employmentTypes(source: FreeJobSource, raw: unknown): string[] | null {
  const list = source === "remotive" ? (raw === undefined ? [""] : [raw]) : raw === undefined ? [] : raw;
  if (!Array.isArray(list) || list.some((t) => typeof t !== "string")) return null;
  return [...new Set((list as string[]).map((t) => t.toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")))].sort();
}

function kindOf(types: string[]): JobInput["kind"] {
  if (types.includes("full_time")) return "full_time";
  return ["contract", "part_time", "freelance"].some((t) => types.includes(t)) ? "contract" : null;
}

/** One listing of the feed in the contract; throws SourceError when its identity is missing (`setAside` sets that one listing aside). */
export function normalize(source: FreeJobSource, item: unknown): JobInput {
  if (item === null || typeof item !== "object" || Array.isArray(item)) throw new SourceError(`${source}: a listing is not an object`);
  const p = item as Record<string, unknown>, f = FIELDS[source];
  if (typeof p.id !== "number" || !Number.isSafeInteger(p.id) || p.id <= 0) throw new SourceError(`${source}: invalid id`);
  const title = p[f.title], rawDescription = p[f.description];
  if (typeof title !== "string" || codePoints(title) < 1 || codePoints(title) > 500) throw new SourceError(`${source}: invalid title`);
  if (typeof rawDescription !== "string" || codePoints(rawDescription) < 1 || codePoints(rawDescription) > 100_000) throw new SourceError(`${source}: full description required`);
  const description = htmlText(rawDescription);
  if (!description) throw new SourceError(`${source}: empty description`);
  // The board's own origin, as both URL parsers read it (leading controls and spaces trimmed, as
  // urlsplit does; tabs and newlines removed; scheme in any case), but spelled exactly: no port, user, other host case or
  // subdomain. The link keeps the board's spelling without query and fragment (WHATWG URL would
  // percent-encode its path).
  const raw = typeof p.url === "string" ? p.url.replace(/^[\x00-\x20]+/, "").replace(/[\t\n\r]/g, "") : "";
  const rest = raw.slice("https://".length);
  if (raw.slice(0, "https://".length).toLowerCase() !== "https://" || !rest.startsWith(`${source}.com${f.path}`)) {
    throw new SourceError(`${source}: invalid job URL`);
  }
  const link = `https://${rest.split(/[?#]/, 1)[0]}`;
  if (!URL.canParse(link)) throw new SourceError(`${source}: invalid job URL`);
  const types = employmentTypes(source, p[f.types]);
  if (types === null) throw new SourceError(`${source}: invalid employment type`);
  const geo = typeof p[f.geo] === "string" ? (p[f.geo] as string) : null;
  const published = p[f.published];
  return parseJobInput({
    external_id: String(p.id), title, description, url: link, canonical_url: link,
    location: geo || null, kind: kindOf(types),
    taiwan_eligible: geo !== null && EXCLUDED_GEO.has(geo.trim().toLowerCase()) ? false : null,
    complete: false,
    // The boards publish in UTC; a time without an offset reads as UTC (plan D8, old rule in listings/legacy.ts).
    published_at: typeof published === "string" ? utcInstant(published) : null,
    extra: { employment_types: types, publication_evidence: typeof published === "string" ? published : null },
  });
}

/** The feed's listings in the contract and the ones the source's rule keeps (contract, part-time, freelance). */
export function parseFeed(source: FreeJobSource, body: Uint8Array): Collected<JobInput> {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SourceError(`${source}: feed is not JSON`);
  }
  const feed = feedSchema.safeParse(data);
  if (!feed.success) throw new SourceError(`${source}: feed has no list of at most 200 jobs`);
  const { listings: all, rejected, examined } = setAside(feed.data.jobs, (item) => normalize(source, item));
  // A board listing a job twice: the last entry wins, as the old per-item intake left it.
  const byId = new Map(all.map((l) => [l.external_id, l]));
  // seen: every job the feed listed (old: all.length, each one normalized or the batch refused).
  return { seen: feed.data.jobs.length, listings: [...byId.values()], sourceKept: (l) => l.kind === "contract", rejected, examined };
}

export function freeJobsConnector(source: FreeJobSource) {
  return async (fetcher: Fetcher): Promise<Collected<JobInput>> => {
    const r = await fetcher.get({
      url: ENDPOINTS[source], maxBytes: 8_000_000, timeoutMs: 25_000,
      headers: { "User-Agent": "side-income/0.1 personal-job-discovery", Accept: "application/json" },
    });
    return parseFeed(source, r.body);
  };
}

import { load } from "cheerio";
import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { awareInstant, lastById, optionalText, pageRequest, requiredText } from "../shared/embedded";
import { jobPostings, pageHtml } from "../shared/job-pages";
import { codePoints, isObject } from "../shared/json";
import { pyStrip, visibleLines } from "../shared/text";
import { SourceError, type Collected, type PageSourceSettings } from "../types";
import { setAside } from "../shared/set-aside";

// Web3.career (plan step 8b, D3; a new source, no old reader): the public front page, its job table
// (`tr[data-jobid]` rows, newest first) and the schema.org JobPosting scripts the page carries for the
// same jobs. One plain request; job pages are not read. Spike (spikes.md §2): 200, 17 jobs.
//
// Identity is the row's numeric job id, which also ends the row's job link (/<slug>/<id>). A row is set
// aside when its id, link or title is missing or the link does not end with the id. The page fails the
// source when it has no job row or more than 200, or a JobPosting script is not JSON. The JobPostings
// carry no URL or id, so a row takes the description of the one JobPosting with the same title and
// company; none or several leave it unknown (D8). The row's time carries its offset; one without stays
// unknown. The table's salary is the site's estimate from similar jobs, not the listing's, so it is not
// kept. Places shown on the row are kept as the location; Taiwan eligibility stays unknown. No rule of
// its own.

const ORIGIN = "https://web3.career";
export const INDEX = ORIGIN + "/";
const MAX_JOBS = 200;
const ID = /^[1-9][0-9]{0,15}$/;

export const WEB3CAREER_SETTINGS: Omit<PageSourceSettings, "order"> = {
  name: "web3career", label: "Web3.career", connector: (fetcher) => web3CareerConnector(fetcher),
  maxTier: "plain", minIntervalMs: 1_000, maxRequestsPerRun: 1, completeRead: false, disabled: null,
};

export type Row = { id: string; href: string; title: string; company: string; places: string[]; time: string };

/**
 * Title and company compared by their letters and digits only: the table drops the punctuation the
 * JobPosting keeps ("Data Engineer, NYC" is "Data Engineer NYC"), and the JobPosting's names arrive
 * HTML-escaped once or twice more than the table's ("Node &amp;amp; Vector").
 */
function bare(s: string): string {
  let t = s;
  for (let before = ""; before !== t; ) [before, t] = [t, t.replaceAll(/&amp;/gi, "&")];
  return t.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, "");
}
const key = (title: string, company: string) => `${bare(title)}\u0000${bare(company)}`;

/** The rows of the job table and the descriptions matched to them by title and company; SourceError when the page is out of bounds. */
export function parseIndex(raw: Uint8Array): { rows: Row[]; descriptions: Map<string, string | null> } {
  const html = pageHtml("web3career", raw);
  const $ = load(html, { scriptingEnabled: false });
  const rows: Row[] = [];
  $("tr[data-jobid]").each((_, tr) => {
    const row = $(tr);
    rows.push({
      id: (row.attr("data-jobid") ?? "").trim(),
      href: (row.find("a[href]").filter((_, a) => !!$(a).find("h2").length).first().attr("href") ?? "").trim(),
      title: row.find("h2").first().text(),
      company: row.find("h3").first().text(),
      places: row.find(".job-location-mobile a").map((_, a) => pyStrip($(a).text())).get().filter(Boolean),
      time: row.find("time[datetime]").first().attr("datetime") ?? "",
    });
  });
  if (!rows.length) throw new SourceError("web3career: no job rows on the page");
  if (rows.length > MAX_JOBS) throw new SourceError("web3career: more than 200 job rows on the page");
  const descriptions = new Map<string, string | null>();
  for (const job of jobPostings("web3career", html)) {
    const org = isObject(job.hiringOrganization) ? job.hiringOrganization.name : undefined;
    if (typeof job.title !== "string" || typeof org !== "string") continue;
    const k = key(job.title, org);
    const text = typeof job.description === "string" ? visibleLines(job.description) : "";
    // Two postings with the same title and company cannot be told apart: neither description is used.
    descriptions.set(k, descriptions.has(k) || !text || codePoints(text) > 100_000 ? null : text);
  }
  return { rows, descriptions };
}

/** One row in the contract; SourceError (set aside) when its identity is missing. */
export function normalizeRow(row: Row, descriptions: Map<string, string | null>): ListingInput {
  if (!ID.test(row.id)) throw new SourceError("web3career: job id required");
  if (!new RegExp(`^/[a-z0-9][a-z0-9-]*/${row.id}$`).test(row.href)) throw new SourceError("web3career: job link required");
  const title = requiredText("web3career", row.title, "title");
  const company = optionalText(row.company);
  const url = ORIGIN + row.href;
  return parseListingInput({
    external_id: row.id, title, company, url, canonical_url: url,
    description: company === null ? null : descriptions.get(key(title, company)) ?? null,
    location: row.places.length ? row.places.join(", ") : null, complete: false,
    published_at: awareInstant(row.time),
    extra: { places: row.places },
  });
}

export async function web3CareerConnector(fetcher: Fetcher): Promise<Collected> {
  const { rows, descriptions } = parseIndex((await fetcher.get(pageRequest(INDEX))).body);
  const read = setAside(rows, (row) => normalizeRow(row, descriptions));
  return { seen: rows.length, listings: lastById(read.listings), sourceKept: () => true, rejected: read.rejected, examined: read.examined };
}

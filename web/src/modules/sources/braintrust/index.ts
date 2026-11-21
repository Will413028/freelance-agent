import { load, type CheerioAPI } from "cheerio";
import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { lastById, lookup, optionalText, requiredText } from "../shared/embedded";
import { pageHtml, renderRequest } from "../shared/job-pages";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// Braintrust (plan step 8d-3, D3; a new source, no old reader): the public app.usebraintrust.com/jobs/ page,
// the latest 20 jobs, rendered by the browser tier (tier 3; 8d-2 from the VM: 20 job links). The render waits
// for the first job link that opens a job (the pagination links `/jobs/?page=n` are drawn without the list).
// Detail pages are not read, so the description stays unknown (D8).
//
// The page has no stable card markup (generated class names), so a job is found by its links: every
// link to `/jobs/<number>` (read with the URL parser) names a job, and its card is the largest ancestor whose links
// are only this job's plus at most one employer link: any other link is page chrome or another job, and a
// second employer link is the next card (a job shown twice is two cards, the last one kept).
// Identity is the number. Title is the first such link's text other than
// the "View job" button; the company is the employer link's `title`.
// A job is set aside when its title is missing. The page fails the source when it has no job link, or
// more than 200 jobs. The pay line (a paragraph with a currency symbol before a number) is evidence only,
// budget stays unknown; the engagement type is read from a closed list. Locations are free text (a country
// list, "+ 2 more"): Taiwan eligibility stays unknown. No rule of its own.

const ORIGIN = "https://app.usebraintrust.com";
export const INDEX = ORIGIN + "/jobs/";
const MAX_JOBS = 200;
/** A selection of rendered nodes (cheerio does not export its node type). */
type Card = ReturnType<CheerioAPI>;
const HOST = "app.usebraintrust.com";
const JOB = /^\/jobs\/([1-9][0-9]{0,15})\/?$/;
const EMPLOYER = /^\/employers\/[0-9]+\/?$/;
/** The job link the render waits for: one that opens a job, not a pagination link. */
export const WAIT_FOR = 'a[target="_blank"][href^="/jobs/"]';

export const BRAINTRUST_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "job",
  name: "braintrust", label: "Braintrust", connector: (fetcher) => braintrustConnector(fetcher),
  maxTier: "browser", minIntervalMs: 3_000, maxRequestsPerRun: 1, completeRead: false, disabled: null,
};

type Job = { id: string; card: Card; $: CheerioAPI };

/** The path of a link on the board, read with the URL parser (relative or absolute); null when it leaves the board. */
function boardPath(href: string | undefined): string | null {
  if (href === undefined || !URL.canParse(href.trim(), ORIGIN)) return null;
  const u = new URL(href.trim(), ORIGIN);
  return u.protocol === "https:" && u.host === HOST && !u.username && !u.password ? u.pathname : null;
}
const jobId = (href: string | undefined) => JOB.exec(boardPath(href) ?? "")?.[1] ?? null;
const isEmployer = (href: string | undefined) => EMPLOYER.test(boardPath(href) ?? "");

/** The jobs of the page in order (a job shown twice is read twice); SourceError when there are none or too many. */
export function parseIndex(raw: Uint8Array): Job[] {
  const $ = load(pageHtml("braintrust", raw), { scriptingEnabled: false });
  const jobs: Job[] = [];
  const read = new Set<unknown>();
  for (const a of $("a[href]").toArray()) {
    const id = jobId($(a).attr("href"));
    if (id === null || read.has(a)) continue;
    let card = $(a);
    for (let up = card.parent(); up.length && !up.is("body"); up = up.parent()) {
      const hrefs = up.find("a[href]").toArray().map((x) => $(x).attr("href"));
      if (hrefs.some((h) => jobId(h) !== id && !isEmployer(h)) || hrefs.filter(isEmployer).length > 1) break;
      card = up;
    }
    for (const x of card.find("a[href]").toArray()) read.add(x);
    jobs.push({ id, card, $ });
  }
  if (!jobs.length) throw new SourceError("braintrust: no jobs on the page");
  if (jobs.length > MAX_JOBS) throw new SourceError("braintrust: more than 200 jobs on the page");
  return jobs;
}

const KIND: Record<string, ListingInput["kind"]> = { Freelance: "contract", Contract: "contract", "Part-time": "contract", "Full-time": "full_time", Employee: "full_time" };
const PAY = /[$€£] ?\d/;

/** One job in the contract; SourceError (set aside) when its title is missing. */
export function normalizeJob({ id, card, $ }: Job): ListingInput {
  // The first of the job's own links with text other than the "View job" button: a cover image link may come first.
  const link = card.find("a[href]").filter((_, a) => jobId($(a).attr("href")) === id && !/^\s*(?:view job\s*)?$/i.test($(a).text())).first();
  const title = requiredText("braintrust", link.text(), "title");
  const url = `${ORIGIN}/jobs/${id}`;
  const texts = card.find("div,span").toArray().map((e) => $(e).text().trim());
  const pay = card.find("p").toArray().map((p) => $(p).text().trim()).find((t) => PAY.test(t)) ?? null;
  return parseListingInput({
    external_id: id, title, company: optionalText(card.find('a[href^="/employers/"] [title]').first().attr("title")), url, canonical_url: url,
    location: null, kind: lookup(KIND, texts.find((t) => Object.hasOwn(KIND, t)) ?? null),
    compensation_evidence: pay, complete: false,
    extra: { roles: card.find("span[title]").not('a[href^="/employers/"] *').toArray().map((s) => $(s).attr("title")) },
  });
}

export async function braintrustConnector(fetcher: Fetcher): Promise<Collected> {
  const jobs = parseIndex((await fetcher.get(renderRequest(INDEX, WAIT_FOR))).body);
  const read = setAside(jobs, normalizeJob);
  return { seen: jobs.length, listings: lastById(read.listings), sourceKept: () => true, rejected: read.rejected, examined: read.examined };
}

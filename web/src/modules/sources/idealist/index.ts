import { load, type CheerioAPI } from "cheerio";
import { parseJobInput, type JobInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { lastById, lookup, optionalText, requiredText } from "../shared/embedded";
import { boardUrl, pageHtml, renderRequest } from "../shared/job-pages";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// Idealist (plan step 8d-3, D3; a new source, no old reader): the public idealist.org/en/jobs search page,
// the latest 20 results, rendered by the browser tier (tier 3). The list is drawn after load, so the render
// waits for the first result's link (8d-2 from the VM: 0 results without waiting; with a wait, 16 nonprofit-job links
// of 20 cards). Detail pages are
// not read, so the description stays unknown (D8).
//
// A result is one `[data-qa-id="search-result"]` card. Its link is a nonprofit, government or other job page
// `/en/<kind>/<32 hex>-<slug>` (the first such link of the card); identity is the 32-hex id (the slug follows the
// title and can change, so any slug passes). A card
// is set aside when its link or title is missing or the link is not such a page. The page fails the source
// when it has no result cards (format changed), or more than 200. The card's tags (workplace, place, type,
// pay) are read only by their text: the place by its location icon, the type from a closed list, pay when a
// tag ends in an amount per hour, day, week, month or year (evidence only, budget stays unknown). The place is free text:
// Taiwan eligibility stays unknown. "Posted 19 days ago" is words only, kept in `extra`. No rule of its own.

const ORIGIN = "https://www.idealist.org";
const HOST = "www.idealist.org";
export const INDEX = ORIGIN + "/en/jobs";
const MAX_JOBS = 200;
/** A selection of rendered nodes (cheerio does not export its node type). */
type Card = ReturnType<CheerioAPI>;
const ARTICLE = /^\/en\/(?:nonprofit-job|government-job|job)\/[0-9a-f]{32}-[^/]*$/;
/** The result link the render waits for (8d-2). */
export const WAIT_FOR = '[data-qa-id="search-result"] a[href]';

export const IDEALIST_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "job",
  name: "idealist", label: "Idealist", connector: (fetcher) => idealistConnector(fetcher),
  maxTier: "browser", minIntervalMs: 3_000, maxRequestsPerRun: 1, completeRead: false, disabled: null,
};

/** The result cards of the page in order; SourceError when there are none or too many. */
export function parseIndex(raw: Uint8Array): Card[] {
  const $ = load(pageHtml("idealist", raw), { scriptingEnabled: false });
  const cards = $('[data-qa-id="search-result"]').toArray().map((el) => $(el));
  if (!cards.length) throw new SourceError("idealist: no jobs on the page");
  if (cards.length > MAX_JOBS) throw new SourceError("idealist: more than 200 jobs on the page");
  return cards;
}

const KIND: Record<string, JobInput["kind"]> = { "Full Time": "full_time", "Part Time": "contract", "Contract/Freelance": "contract", Temporary: "contract" };
const PAY = /\d[\d,.]*\s*\/\s*(?:hour|day|week|month|year)$/;

/** One card in the contract; SourceError (set aside) when its identity is missing. */
export function normalizeCard(card: Card): JobInput {
  const url = card.find("a[href]").toArray().map((a) => boardUrl(ORIGIN, HOST, ARTICLE, card.find(a).attr("href"))).find((u) => u !== null) ?? null;
  if (!url) throw new SourceError("idealist: job link required");
  const id = /\/([0-9a-f]{32})-/.exec(url)![1];
  const title = requiredText("idealist", card.find('[data-qa-id="search-result-link"]').first().text(), "title");
  const tags = card.find('span[data-size="micro"]').toArray().map((t) => card.find(t));
  const texts = tags.map((t) => t.text().trim());
  const place = tags.find((t) => t.find('[aria-label^="location"]').length);
  const type = texts.find((t) => Object.hasOwn(KIND, t)) ?? null;
  return parseJobInput({
    external_id: id, title, company: optionalText(card.find("h4").first().text()), url, canonical_url: url,
    location: place ? optionalText(place.text()) : null, kind: lookup(KIND, type),
    compensation_evidence: texts.find((t) => PAY.test(t)) ?? null, complete: false,
    extra: { tags: texts, posted: optionalText(card.find("span").filter((_, s) => /^Posted\b/.test(card.find(s).text().trim())).first().text()) },
  });
}

export async function idealistConnector(fetcher: Fetcher): Promise<Collected<JobInput>> {
  const cards = parseIndex((await fetcher.get(renderRequest(INDEX, WAIT_FOR))).body);
  const read = setAside(cards, normalizeCard);
  return { seen: cards.length, listings: lastById(read.listings), sourceKept: () => true, rejected: read.rejected, examined: read.examined };
}

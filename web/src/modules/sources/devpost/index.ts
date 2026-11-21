import { parseContestInput, type ContestInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { htmlText } from "../shared/html";
import { codePoints, isObject } from "../shared/json";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// Devpost: the public JSON list of open hackathons, read page by page (opportunity types plan step 5; the
// fields are those measured in docs/plans/2026-11-20-opportunity-types/sources.md). Kept by Will's decision
// D9 although the site's terms forbid automated access: robots.txt allows it and this is one read a day.
// A hackathon without its identity (integer id, title, its own devpost.com page) is set aside and counted
// in `rejected`; a page that is not JSON or has no list refuses the run. Every other field the connector
// cannot read is unknown (null): the list gives no registration deadline, no region, age or student rule.
// The source has no rule of its own: an invite-only hackathon is kept and marked (plan D3).

export const ENDPOINT = "https://devpost.com/api/hackathons";
export const pageUrl = (page: number) => `${ENDPOINT}?status[]=open&page=${page}`;
/** The requests of one run: 30 pages of 9 is over four times the 64 open hackathons measured (2026-11-21). */
export const MAX_PAGES = 30;
/** A resource bound per page, not the provider's page size (9). */
const MAX_PAGE_ENTRIES = 200;
const MAX_BYTES = 2_000_000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The three spellings of the submission period seen: `Nov 03 - 21, 2026`, `Nov 03 - Dec 15, 2026`, `Dec 01, 2026 - Jan 15, 2027`. */
const PERIOD = /^[A-Z][a-z]{2} \d{1,2}(?:, \d{4})? - (?:([A-Z][a-z]{2}) )?(\d{1,2}), (\d{4})$/;

/**
 * The submission deadline: the last day of `submission_period_dates`. The list gives a day without a time
 * or a zone, so it is a date deadline, which expires at the end of that day in Asia/Taipei (rebuild plan
 * D7): up to a day before the organiser's own end of day, never after it. A period in another spelling
 * is kept as its text, unusable.
 */
export function deadlineOf(period: unknown): ContestInput["deadline"] {
  if (period === undefined || period === null) return null;
  if (typeof period !== "string") return { kind: "invalid", text: JSON.stringify(period) };
  const m = PERIOD.exec(period);
  const month = m ? MONTHS.indexOf(m[1] ?? period.slice(0, 3)) : -1;
  if (!m || month < 0) return { kind: "invalid", text: period };
  const day = Number(m[2]), year = Number(m[3]);
  const d = new Date(Date.UTC(year, month, day));
  // A day the month does not have (Feb 30) rolls over in Date: refuse it instead.
  if (year < 1000 || d.getUTCMonth() !== month || d.getUTCDate() !== day) return { kind: "invalid", text: period };
  return { kind: "date", date: d.toISOString().slice(0, 10) };
}

/**
 * The currency a prize's prefix names. Devpost writes other dollars with their code (`$CAD`), so a bare `$`
 * is read as USD (inferred from that spelling, not stated by the API). A prefix not listed is unknown.
 */
const CURRENCIES: Readonly<Record<string, string>> = { $: "USD", $CAD: "CAD", "€": "EUR" };
const PRIZE = /^([^<]*)<span data-currency-value>([0-9][0-9,]*)<\/span>$/;

/**
 * `prize_amount` (`$<span data-currency-value>10,000</span>`): the text as shown, and the amount with its
 * currency when both are read. No prize field, or one in another form, is an unknown amount, never 0.
 */
export function prizeOf(value: unknown): Pick<ContestInput, "prize_text" | "budget_max" | "currency"> {
  const unknown = { budget_max: null, currency: null };
  if (typeof value !== "string" || !value.trim()) return { prize_text: null, ...unknown };
  const prize_text = htmlText(value) || null;
  const m = PRIZE.exec(value.trim());
  const currency = m ? CURRENCIES[m[1].trim()] : undefined;
  const amount = m ? Number(m[2].replaceAll(",", "")) : NaN;
  if (currency === undefined || !Number.isSafeInteger(amount)) return { prize_text, ...unknown };
  return { prize_text, budget_max: amount, currency };
}

/** The hackathon's own page: `https://<name>.devpost.com/`, without query and fragment. */
function contestUrl(value: unknown): string {
  const u = typeof value === "string" && URL.canParse(value) ? new URL(value) : null;
  if (!u || u.protocol !== "https:" || u.username || u.password || u.port || !u.hostname.endsWith(".devpost.com")) throw new SourceError("devpost: invalid hackathon URL");
  return `${u.origin}/`;
}

const textOr = (v: unknown, max: number) => (typeof v === "string" && v.trim() && codePoints(v) <= max ? v.trim() : null);
const flag = (v: unknown) => (typeof v === "boolean" ? v : null);

/** One hackathon in the contract; throws SourceError when its identity is missing (`setAside` sets that one aside). */
export function normalize(item: unknown): ContestInput {
  if (!isObject(item)) throw new SourceError("devpost: a hackathon is not an object");
  const { id, title } = item;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new SourceError("devpost: identifier required");
  if (typeof title !== "string" || codePoints(title.trim()) < 1 || codePoints(title) > 500) throw new SourceError("devpost: invalid title");
  const url = contestUrl(item.url);
  const place = isObject(item.displayed_location) ? item.displayed_location : {};
  const location = textOr(place.location, 500);
  const themes = Array.isArray(item.themes) ? item.themes.flatMap((t) => (isObject(t) && typeof t.name === "string" ? [t.name] : [])) : [];
  return parseContestInput({
    opportunity_type: "contest", external_id: String(id), title: title.trim(), company: textOr(item.organization_name, 500), url, canonical_url: url, location,
    ...prizeOf(item.prize_amount),
    // `Online` is the list's own wording; an in-person hackathon carries a place and the map marker.
    online: location === "Online" ? true : location !== null && place.icon === "map-marker-alt" ? false : null,
    invite_only: flag(item.invite_only),
    // The list is Devpost's hackathons.
    hackathon: true,
    listing_closed: item.winners_announced === true ? true : item.open_state === "open" ? false : typeof item.open_state === "string" ? true : null,
    deadline: deadlineOf(item.submission_period_dates),
    extra: { themes, prizes_counts: isObject(item.prizes_counts) ? item.prizes_counts : null, invite_only_description: textOr(item.eligibility_requirement_invite_only_description, 2000) },
  });
}

/** One API page: its hackathons and the open total the page states. */
export function parsePage(body: Uint8Array): { entries: unknown[]; total: number } {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SourceError("devpost: page is not JSON");
  }
  if (!isObject(data) || !Array.isArray(data.hackathons) || data.hackathons.length > MAX_PAGE_ENTRIES) throw new SourceError("devpost: invalid API envelope");
  const total = isObject(data.meta) ? data.meta.total_count : null;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) throw new SourceError("devpost: no total count");
  return { entries: data.hackathons, total };
}

/**
 * Every page until an empty one or the page cap: each hackathon once by id, as last read (the list can
 * shift between two requests). `truncated` when fewer distinct hackathons were read than the list's own
 * total: the cap was reached, or the list shifted and one was missed, so the read is not complete and
 * nothing is marked gone.
 */
export async function scan(fetcher: Fetcher): Promise<{ seen: number; listings: ContestInput[]; truncated: boolean; rejected: number; examined: number }> {
  const contests = new Map<string, ContestInput>();
  const ids = new Set<unknown>();
  let seen = 0, rejected = 0, examined = 0, total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetcher.get({ url: pageUrl(page), maxBytes: MAX_BYTES, timeoutMs: 25_000, headers: { "User-Agent": "side-income/0.1 personal-job-discovery", Accept: "application/json" } });
    const p = parsePage(r.body);
    total = p.total;
    if (!p.entries.length) break;
    seen += p.entries.length;
    for (const e of p.entries) ids.add(isObject(e) ? e.id : e);
    const kept = setAside(p.entries, (e) => {
      const c = normalize(e);
      contests.set(c.external_id, c);
      return c;
    });
    rejected += kept.rejected;
    examined += kept.examined;
    if (ids.size >= total) break;
  }
  return { seen, listings: [...contests.values()], truncated: ids.size < total, rejected, examined };
}

export async function devpostConnector(fetcher: Fetcher): Promise<Collected<ContestInput>> {
  return { ...(await scan(fetcher)), sourceKept: () => true };
}

export const DEVPOST_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "contest",
  label: "Devpost", name: "devpost", connector: devpostConnector, maxTier: "plain",
  minIntervalMs: 2_000, maxRequestsPerRun: MAX_PAGES,
  // One untruncated read pages through every open hackathon; one that ended leaves the list (plan D9).
  completeRead: true, disabled: null,
};

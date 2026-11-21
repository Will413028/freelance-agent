import { parseContestInput, type ContestInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { codePoints, isObject } from "../shared/json";
import { pageHtml, pageRequest } from "../shared/job-pages";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// MLContests: one page whose `data-competitions` attribute holds every competition it tracks, current and
// past, as an HTML-escaped JSON array (opportunity types plan step 6a; fields measured in
// docs/plans/2026-11-20-opportunity-types/sources.md, re-measured 2026-11-22: 413 entries, 15 open). The
// list has no id and no open state: the competition's URL is the id (D7 = A), read with the URL parser and
// stripped of the tracking parameters the site adds (`ref`, `utm_*`) and of its fragment, and a competition
// is open while its deadline day has not passed in Asia/Taipei. Past competitions are not read; one whose
// deadline the connector cannot read, and cannot tell is past, is set aside and counted in `rejected`, since it cannot tell whether
// it is open. The same competition can also come from its own platform (Zindi, Devpost): nothing is merged
// (rebuild plan D18).

export const PAGE_URL = "https://mlcontests.com/";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `D Mon YYYY` (`5 Dec 2026`, `15 Dec 2026`) as an ISO date; null for any other spelling or a day the month lacks. */
export function dayOf(value: unknown): string | null {
  const m = typeof value === "string" ? /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(value.trim()) : null;
  const month = m ? MONTHS.indexOf(m[2]) : -1;
  if (!m || month < 0) return null;
  const day = Number(m[1]), year = Number(m[3]);
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

const TRACKING = (key: string) => key === "ref" || key.startsWith("utm_");

/** The competition's URL without tracking parameters or fragment; throws when it is not an https URL. */
export function competitionUrl(value: unknown): string {
  const u = typeof value === "string" && URL.canParse(value.trim()) ? new URL(value.trim()) : null;
  if (!u || u.protocol !== "https:" || u.username || u.password) throw new SourceError("mlcontests: invalid competition URL");
  for (const key of [...u.searchParams.keys()]) if (TRACKING(key)) u.searchParams.delete(key);
  u.hash = "";
  return u.href;
}

/** `prize` (`$25,000`): the site's amounts are US dollars (sources.md). Null or another form is an unknown amount, never 0. */
export function prizeOf(value: unknown): Pick<ContestInput, "prize_text" | "budget_max" | "currency"> {
  const unknown = { budget_max: null, currency: null };
  if (typeof value !== "string" || !value.trim() || codePoints(value) > 500) return { prize_text: null, ...unknown };
  const prize_text = value.trim();
  const m = /^\$(\d{1,3}(?:,\d{3})*|\d+)$/.exec(prize_text);
  const amount = m ? Number(m[1].replaceAll(",", "")) : NaN;
  if (!m || !Number.isSafeInteger(amount)) return { prize_text, ...unknown };
  return { prize_text, budget_max: amount, currency: "USD" };
}

const textOr = (v: unknown, max: number) => (typeof v === "string" && v.trim() && codePoints(v) <= max ? v.trim() : null);

/** One competition in the contract; throws SourceError when its identity or deadline is missing (`setAside` sets that one aside). */
export function normalize(item: unknown): ContestInput {
  if (!isObject(item)) throw new SourceError("mlcontests: a competition is not an object");
  const title = item.name;
  if (typeof title !== "string" || codePoints(title.trim()) < 1 || codePoints(title) > 500) throw new SourceError("mlcontests: invalid title");
  const url = competitionUrl(item.url);
  const date = dayOf(item.deadline);
  if (date === null) throw new SourceError("mlcontests: unreadable deadline");
  return parseContestInput({
    opportunity_type: "contest", external_id: url, title: title.trim(), company: textOr(item.platform, 500), url, canonical_url: url,
    ...prizeOf(item.prize),
    // The list states none of these; an ML competition is usually online, but that is not stated.
    online: null, invite_only: null, hackathon: null, listing_closed: null,
    // A day without a time or zone: a date deadline, ending with that day in Asia/Taipei (rebuild plan D7).
    deadline: { kind: "date", date },
    registration_deadline: dayOf(item["registration-deadline"]),
    extra: { sponsor: textOr(item.sponsor, 500), additional_prizes: textOr(item["additional-prizes"], 2000), tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === "string") : [] },
  });
}

/** The competitions in the page's `data-competitions` attribute. */
export function parsePage(body: Uint8Array): unknown[] {
  const html = pageHtml("mlcontests", body);
  const attrs = [...html.matchAll(/data-competitions="([^"]*)"/g)];
  if (attrs.length !== 1) throw new SourceError("mlcontests: competition list not found");
  let data: unknown;
  try {
    data = JSON.parse(unescapeAttribute(attrs[0][1]));
  } catch {
    throw new SourceError("mlcontests: competition list is not JSON");
  }
  if (!Array.isArray(data)) throw new SourceError("mlcontests: competition list is not an array");
  return data;
}

/** The HTML character references an attribute value can hold (named ones the page uses, and numeric). */
function unescapeAttribute(s: string): string {
  const named: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: " " };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, ref: string) => {
    if (ref[0] === "#") {
      const n = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return Object.hasOwn(named, ref.toLowerCase()) ? named[ref.toLowerCase()] : all;
  });
}

/**
 * A deadline in another spelling whose every `Mon YYYY` month ended before today (`11 May 2026 Apr 2026`,
 * measured 2026-11-22): a past competition, left out like the others instead of set aside, so it does not
 * count as a refusal on every read (that would keep the read from ever being complete, and fail the source
 * on a day with few open competitions). A spelling with no month in it is not known to be past.
 */
export function pastMonths(value: unknown, today: string): boolean {
  if (typeof value !== "string") return false;
  const months = [...value.matchAll(/\b([A-Z][a-z]{2}) (\d{4})\b/g)].map((m) => [MONTHS.indexOf(m[1]), Number(m[2])] as const);
  if (!months.length || months.some(([m]) => m < 0)) return false;
  const thisMonth = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1;
  return months.every(([m, y]) => y * 12 + m < thisMonth);
}

/** Today's date in Asia/Taipei. */
const taipeiDay = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/**
 * The open competitions: every entry whose deadline day is today or later in Taipei, or unreadable and not
 * known to be past (set aside). The page holds the whole list, so the read is complete unless two open entries share a URL
 * (each is kept once, as last read, and the read is marked truncated so neither is marked gone).
 */
export function scan(entries: unknown[], now: Date): { seen: number; listings: ContestInput[]; truncated: boolean; rejected: number; examined: number } {
  const today = taipeiDay(now);
  const current = entries.filter((e) => {
    const d = isObject(e) ? dayOf(e.deadline) : null;
    return d !== null ? d >= today : !(isObject(e) && pastMonths(e.deadline, today));
  });
  const contests = new Map<string, ContestInput>();
  const kept = setAside(current, (e) => {
    const c = normalize(e);
    contests.set(c.external_id, c);
    return c;
  });
  return { seen: entries.length, listings: [...contests.values()], truncated: contests.size !== kept.listings.length, rejected: kept.rejected, examined: kept.examined };
}

export async function mlcontestsConnector(fetcher: Fetcher, now: Date): Promise<Collected<ContestInput>> {
  const r = await fetcher.get(pageRequest(PAGE_URL));
  return { ...scan(parsePage(r.body), now), sourceKept: () => true };
}

export const MLCONTESTS_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "contest",
  label: "MLContests", name: "mlcontests", connector: mlcontestsConnector, maxTier: "plain",
  minIntervalMs: 2_000, maxRequestsPerRun: 1,
  // One page holds the whole list; a competition whose deadline passed leaves the read (plan D9).
  completeRead: true, disabled: null,
};

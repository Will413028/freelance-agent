import { parseContestInput, type ContestInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { codePoints, isObject } from "../shared/json";
import { USER_AGENT } from "../shared/job-pages";
import { setAside } from "../shared/set-aside";
import { awareInstant } from "../shared/time";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// Zindi: the public JSON list of competitions (opportunity types plan step 6a; fields measured in
// docs/plans/2026-11-20-opportunity-types/sources.md, re-measured 2026-11-22). The list holds every
// competition, open and closed, open ones first: `active=true` does not filter (with `per_page` it returns
// closed ones too, measured 2026-11-22), so the connector pages until the first closed competition and keeps
// the open ones. A competition without its identity (slug id, title) is set aside and counted in `rejected`;
// a page that is not JSON or has no list or counts refuses the run. The list gives no region, age or student
// rule and no place: those stay unknown (null), an online competition is not assumed.

export const ENDPOINT = "https://api.zindi.africa/v1/competitions";
export const PER_PAGE = 50;
export const pageUrl = (page: number) => `${ENDPOINT}?page=${page}&per_page=${PER_PAGE}`;
/** 12 pages of 50 cover the 527 competitions listed on 2026-11-22; the open ones (10) fit the first. */
export const MAX_PAGES = 12;
const MAX_BYTES = 2_000_000;
/** The competition page: zindi.africa answers 301 to zindi.world (measured 2026-11-22). */
export const competitionUrl = (id: string) => `https://zindi.world/competitions/${id}`;

/**
 * `reward` with `reward_type: prize`: the amount and its currency code, written last (`$40 000 USD`,
 * `€9 000 EUR`, `R25 000 ZAR`, `5 000 CHF`); thousands are separated by a space or a comma. Any other
 * wording (`$12 000 USD + AWS credits`, `To be awarded`) keeps the text and leaves the amount unknown; a
 * reward in points is not a prize amount (plan step 6a).
 */
const REWARD = /^\D{0,3}?(\d{1,3}(?:[ ,]\d{3})*|\d+) ([A-Z]{3})$/;

export function rewardOf(reward: unknown, type: unknown): Pick<ContestInput, "prize_text" | "budget_max" | "currency"> {
  const unknown = { budget_max: null, currency: null };
  if (typeof reward !== "string" || !reward.trim() || codePoints(reward) > 500) return { prize_text: null, ...unknown };
  const prize_text = reward.trim();
  const m = type === "prize" ? REWARD.exec(prize_text) : null;
  const amount = m ? Number(m[1].replace(/[ ,]/g, "")) : NaN;
  if (!m || !Number.isSafeInteger(amount)) return { prize_text, ...unknown };
  return { prize_text, budget_max: amount, currency: m[2] };
}

const textOr = (v: unknown, max: number) => (typeof v === "string" && v.trim() && codePoints(v) <= max ? v.trim() : null);

/** Invite-only when either flag says so, open when both say not, unknown otherwise (plan step 6a). */
function inviteOnly(secret: unknown, restricted: unknown): boolean | null {
  if (secret === true || restricted === true) return true;
  return secret === false && restricted === false ? false : null;
}

/** One competition in the contract; throws SourceError when its identity is missing (`setAside` sets that one aside). */
export function normalize(item: unknown): ContestInput {
  if (!isObject(item)) throw new SourceError("zindi: a competition is not an object");
  const { id, title } = item;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,199}$/.test(id)) throw new SourceError("zindi: identifier required");
  if (typeof title !== "string" || codePoints(title.trim()) < 1 || codePoints(title) > 500) throw new SourceError("zindi: invalid title");
  const url = competitionUrl(id);
  // `end_time` is an instant (`2026-12-13T04:59:00.000Z`); one without its offset is kept as text, unusable.
  const end = item.end_time;
  const at = awareInstant(end);
  const deadline: ContestInput["deadline"] = end === undefined || end === null ? null
    : at !== null ? { kind: "instant", at }
    : { kind: "invalid", text: typeof end === "string" ? end : JSON.stringify(end) };
  // Entries close at an instant; `registration_deadline` is a date that lasts to the end of its day in
  // Taipei (rebuild plan D7), which would overstate the close by up to a day, so the instant is kept in
  // `extra` only.
  const closes = awareInstant(item.entries_close_at);
  return parseContestInput({
    opportunity_type: "contest", external_id: id, title: title.trim(), company: textOr(item.organization, 500), url, canonical_url: url,
    ...rewardOf(item.reward, item.reward_type),
    online: null,
    invite_only: inviteOnly(item.secret_code_required, item.is_access_restricted),
    hackathon: item.kind === "hackathon" ? true : item.kind === "competition" ? false : null,
    listing_closed: item.open === true ? false : item.open === false ? true : null,
    deadline,
    registration_deadline: null,
    extra: { reward_type: textOr(item.reward_type, 100), entries_close_at: closes, beginner_friendly: typeof item.is_beginner_friendly === "boolean" ? item.is_beginner_friendly : null },
  });
}

/** One API page: its competitions and the open count the page states. */
export function parsePage(body: Uint8Array): { entries: unknown[]; openCount: number } {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SourceError("zindi: page is not JSON");
  }
  if (!isObject(data) || !Array.isArray(data.data) || data.data.length > PER_PAGE) throw new SourceError("zindi: invalid API envelope");
  const openCount = isObject(data.meta) ? data.meta.open_count : null;
  if (typeof openCount !== "number" || !Number.isSafeInteger(openCount) || openCount < 0) throw new SourceError("zindi: no open count");
  return { entries: data.data, openCount };
}

/**
 * Pages until one that holds a closed competition, an empty page or the page cap; keeps each open
 * competition once by id, as last read. `truncated` unless the read reached a closed competition or the
 * list's end, every page stated the same open count, no competition was shown twice and as many open ones
 * were read as that count (an open one after a closed one, or one shown twice, means the order shifted).
 */
export async function scan(fetcher: Fetcher): Promise<{ seen: number; listings: ContestInput[]; truncated: boolean; rejected: number; examined: number }> {
  const contests = new Map<string, ContestInput>();
  const ids = new Set<unknown>();
  const counts = new Set<number>();
  let seen = 0, rejected = 0, examined = 0, ended = false, openAfterClosed = false;
  for (let page = 0; page < MAX_PAGES && !ended; page++) {
    const r = await fetcher.get({ url: pageUrl(page), maxBytes: MAX_BYTES, timeoutMs: 25_000, headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    const p = parsePage(r.body);
    counts.add(p.openCount);
    if (!p.entries.length) {
      ended = true;
      break;
    }
    const closedAt = p.entries.findIndex((e) => !isObject(e) || e.open !== true);
    const open = closedAt < 0 ? p.entries : p.entries.slice(0, closedAt);
    if (closedAt >= 0) {
      ended = true;
      openAfterClosed = p.entries.slice(closedAt).some((e) => isObject(e) && e.open === true);
    }
    seen += open.length;
    for (const e of open) ids.add((e as Record<string, unknown>).id);
    const kept = setAside(open, (e) => {
      const c = normalize(e);
      contests.set(c.external_id, c);
      return c;
    });
    rejected += kept.rejected;
    examined += kept.examined;
    if (p.entries.length < PER_PAGE) ended = true;
  }
  const complete = ended && !openAfterClosed && counts.size === 1 && seen === ids.size && counts.has(ids.size);
  return { seen, listings: [...contests.values()], truncated: !complete, rejected, examined };
}

export async function zindiConnector(fetcher: Fetcher): Promise<Collected<ContestInput>> {
  return { ...(await scan(fetcher)), sourceKept: () => true };
}

export const ZINDI_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "contest",
  label: "Zindi", name: "zindi", connector: zindiConnector, maxTier: "plain",
  minIntervalMs: 2_000, maxRequestsPerRun: MAX_PAGES,
  // One untruncated read holds every open competition; one that closed leaves the open part (plan D9).
  completeRead: true, disabled: null,
};

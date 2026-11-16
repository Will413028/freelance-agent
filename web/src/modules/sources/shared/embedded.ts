import { load } from "cheerio";
import { parseLegacyIsoTime, type ListingInput } from "@/modules/listings/public";
import type { FetchRequest } from "@/platform/fetch";
import { isObject } from "./json";
import { PAGE_BYTES, PAGE_TIMEOUT_MS, USER_AGENT } from "./job-pages";
import { pyStrip } from "./text";
import { SourceError } from "../types";

// Readers for the data a board embeds in its own listing page (plan step 8b: Arc, Wellfound, Remote.com
// Jobs, YC, Web3.career): Next.js page props, a Next.js server-component stream, an Inertia data-page
// attribute. Each source reads one public page with one plain request; these only find and decode the
// embedded JSON. A missing or undecodable payload is a batch problem (SourceError): the format changed.

/** One plain GET of a board page (checklist §1: through the Fetcher, the page limits of job-pages). */
export const pageRequest = (url: string): FetchRequest => ({ url, maxBytes: PAGE_BYTES, timeoutMs: PAGE_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT } });

/** The props of a Next.js page (`<script id="__NEXT_DATA__">`). */
export function nextData(name: string, html: string): Record<string, unknown> {
  const $ = load(html, { scriptingEnabled: false });
  const script = $("script#__NEXT_DATA__");
  if (script.length !== 1) throw new SourceError(`${name}: page data not found`);
  let value: unknown;
  try {
    value = JSON.parse(script.text());
  } catch {
    throw new SourceError(`${name}: page data is not JSON`);
  }
  if (!isObject(value) || !isObject(value.props) || !isObject(value.props.pageProps)) throw new SourceError(`${name}: page props not found`);
  return value.props.pageProps;
}

/** The JSON of an Inertia page (`data-page` attribute of the app element). */
export function inertiaPage(name: string, html: string): Record<string, unknown> {
  const $ = load(html, { scriptingEnabled: false });
  const attr = $("[data-page]").first().attr("data-page");
  if (attr === undefined) throw new SourceError(`${name}: page data not found`);
  let value: unknown;
  try {
    value = JSON.parse(attr);
  } catch {
    throw new SourceError(`${name}: page data is not JSON`);
  }
  if (!isObject(value) || !isObject(value.props)) throw new SourceError(`${name}: page props not found`);
  return value.props;
}

/** The end (exclusive) of the JSON object or array starting at `start`, skipping brackets inside strings; -1 when unbalanced. */
function jsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * The value under `"<key>":` in a Next.js server-component stream: the page's
 * `self.__next_f.push([1,"…"])` chunks, each a JSON string, joined in order. Exactly one occurrence of
 * the key, holding an object, is accepted; anything else refuses the page.
 */
export function flightValue(name: string, html: string, key: string): Record<string, unknown> {
  const $ = load(html, { scriptingEnabled: false });
  let flight = "";
  const push = /^\s*self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)\s*;?\s*$/s;
  $("script").each((_, el) => {
    const m = push.exec($(el).text());
    if (!m) return;
    try {
      flight += JSON.parse(m[1]) as string;
    } catch {
      throw new SourceError(`${name}: page stream is not JSON`);
    }
  });
  const marker = JSON.stringify(key) + ":";
  const at = flight.indexOf(marker);
  if (at < 0 || flight.indexOf(marker, at + 1) >= 0) throw new SourceError(`${name}: expected one ${key} in the page stream`);
  const start = at + marker.length;
  const end = flight[start] === "{" ? jsonEnd(flight, start) : -1;
  if (end < 0) throw new SourceError(`${name}: ${key} is not an object`);
  let value: unknown;
  try {
    value = JSON.parse(flight.slice(start, end));
  } catch {
    throw new SourceError(`${name}: ${key} is not JSON`);
  }
  if (!isObject(value)) throw new SourceError(`${name}: ${key} is not an object`);
  return value;
}

/** Required text of one listing: a string with visible characters, at most `max` characters; SourceError (set aside) otherwise. */
export function requiredText(name: string, value: unknown, what: string, max = 500): string {
  if (typeof value !== "string" || !pyStrip(value)) throw new SourceError(`${name}: ${what} required`);
  const text = pyStrip(value);
  if ([...text].length > max) throw new SourceError(`${name}: ${what} too long`);
  return text;
}

/** Optional text: trimmed, or null when absent, not a string or blank (unknown, D8). */
export const optionalText = (value: unknown): string | null => (typeof value === "string" && pyStrip(value) ? pyStrip(value) : null);

const rfc3339 = (d: Date) => (Number.isFinite(d.getTime()) && d.getUTCFullYear() >= 1 && d.getUTCFullYear() <= 9999 ? d.toISOString() : null);

/** Unix seconds as an instant; null when not a finite number (unknown, D8). */
export const epochInstant = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? rfc3339(new Date(value * 1000)) : null;

/** An ISO 8601 time that carries its offset; a time without one, or not a time, is null (unknown, D8). */
export function awareInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = parseLegacyIsoTime(value.trim().replaceAll("Z", "+00:00"));
  return t?.kind === "aware" ? rfc3339(t.instant) : null;
}

/** Names that do not rule Taiwan out: Taiwan itself and the broad regions that contain it. */
const BROAD = new Set(["tw", "twn", "taiwan", "taiwan, province of china", "asia", "apac", "asia pacific", "worldwide", "anywhere", "global", "earth"]);

/**
 * Taiwan eligibility from a list of required places (countries or regions): false only when the source
 * lists places and none of them is Taiwan or a region containing it; null otherwise. Remote is not
 * worldwide (AGENTS.md): an empty or unreadable list stays unknown.
 */
export function eligibleFrom(places: readonly string[] | null): ListingInput["taiwan_eligible"] {
  if (places === null || !places.length) return null;
  return places.some((p) => BROAD.has(p.trim().toLowerCase())) ? null : false;
}

/** A list of strings, or null when it is not one (unknown, D8). */
export function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return null;
  return value.map((v) => v.trim()).filter(Boolean);
}

/** The listings of one read with duplicate ids collapsed to the last one (checklist §2). */
export function lastById(listings: readonly ListingInput[]): ListingInput[] {
  const byId = new Map<string, ListingInput>();
  for (const l of listings) byId.set(l.external_id, l);
  return [...byId.values()];
}

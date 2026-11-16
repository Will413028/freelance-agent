import { load } from "cheerio";
import type { ListingInput } from "@/modules/listings/public";
import { isObject } from "./json";
import { pyStrip } from "./text";
import { SourceError } from "../types";

// Readers for the data a board embeds in its own listing page (plan step 8b: Arc, Wellfound, Remote.com
// Jobs, YC, Web3.career): Next.js page props, a Next.js server-component stream, an Inertia data-page
// attribute. Each source reads one public page with one plain request; these only find and decode the
// embedded JSON. A missing or undecodable payload is a batch problem (SourceError): the format changed.

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
    // Flight escapes a string that starts with "$" as "$$…" and sends a Date as "$D<ISO>"; other "$…"
    // strings are references this reader does not follow, left as they are (they fail the field checks).
    value = JSON.parse(flight.slice(start, end), (_, v: unknown) =>
      typeof v === "string" && v.startsWith("$") ? (v.startsWith("$$") ? v.slice(1) : v.startsWith("$D") ? v.slice(2) : v) : v);
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

/**
 * Taiwan eligibility from ISO 3166 alpha-2 country codes the hire must be in: false when the source
 * lists codes and none is TW; null otherwise. Only a closed vocabulary can say "Taiwan is not in it":
 * free-text places (a city, "Asia-Pacific") are never read as an exclusion, since a false here hides
 * the listing (evaluation's hard exclusion), and remote is not worldwide (AGENTS.md).
 */
export function eligibleFromCodes(codes: readonly string[] | null): ListingInput["taiwan_eligible"] {
  if (codes === null || !codes.length || !codes.every((c) => /^[A-Za-z]{2}$/.test(c))) return null;
  return codes.some((c) => c.toUpperCase() === "TW") ? null : false;
}

/** A value of a closed set, or null for anything else (an own key only: "constructor" is not one). */
export const lookup = <V>(table: Record<string, V>, key: unknown): V | null =>
  typeof key === "string" && Object.hasOwn(table, key) ? table[key] : null;

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

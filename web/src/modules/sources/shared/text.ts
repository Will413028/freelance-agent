import { load } from "cheerio";

// Text helpers several connectors share (merged in plan step 5b from per-connector copies).

/** Python's str.isspace set (it differs from JavaScript's \s and trim: U+001C–U+001F and U+0085 yes, BOM no). */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEADING = new RegExp(`^[${PY_SPACE}]+`, "u"), TRAILING = new RegExp(`[${PY_SPACE}]+$`, "u");

export const pyRstrip = (s: string) => s.replace(TRAILING, "");
/** str.strip() */
/** Every whitespace run collapsed to one space, without leading or trailing space. */
export const collapseSpaces = (s: string) => s.split(/\s+/u).filter(Boolean).join(" ");

export const pyStrip = (s: string) => pyRstrip(s.replace(LEADING, ""));

/** Python's str.splitlines() boundaries. */
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u;
const BLOCKS = "p, div, li, h1, h2, h3, tr";

/**
 * Visible text of an HTML fragment keeping its lines: script and style dropped, block tags (p, div, li,
 * h1–h3, tr, br) as line breaks, whitespace collapsed within each line, blank lines dropped; "" when
 * nothing shows. A stray block end tag breaks the line too, as it did in the old parser.
 */
export function visibleLines(html: string): string {
  const $ = load(html.replace(/<\/(?:p|div|li|br|h1|h2|h3|tr)\s*>/gi, (m) => `\n${m}\n`), { scriptingEnabled: false }, false);
  $("script, style").remove();
  $(BLOCKS).before("\n").after("\n");
  $("br").replaceWith("\n");
  return $.root().text().split(LINE_BREAK).map((line) => collapseSpaces(line)).filter(Boolean).join("\n");
}

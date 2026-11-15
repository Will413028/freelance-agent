import { load } from "cheerio";

/** Visible text of an HTML fragment: script and style dropped, block tags as spaces, whitespace collapsed. */
export function htmlText(html: string): string {
  const $ = load(html, { scriptingEnabled: false }, false);
  $("script, style").remove();
  $("p, div, li").before(" ").after(" ");
  $("br").replaceWith(" ");
  return $.root().text().split(/\s+/u).filter(Boolean).join(" ");
}

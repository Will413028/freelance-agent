import { load } from "cheerio";

/** Visible text of an HTML fragment: script and style dropped, block tags as spaces, whitespace collapsed. */
export function htmlText(html: string): string {
  // A stray block end tag (</p> without its start, </br>) breaks words too, as it did in the old parser;
  // the HTML parser drops such tags, so the break is marked in the text first.
  const $ = load(html.replace(/<\/(?:p|div|li|br)\s*>/gi, (m) => ` ${m} `), { scriptingEnabled: false }, false);
  $("script, style").remove();
  $("p, div, li").before(" ").after(" ");
  $("br").replaceWith(" ");
  return $.root().text().split(/\s+/u).filter(Boolean).join(" ");
}

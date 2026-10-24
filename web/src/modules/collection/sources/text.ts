import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { parsedateToDatetime } from "@/platform/py/email";
import { htmlFeed } from "@/platform/py/html";
import { pyLen, pySplit, pySplitlines, pyStrip } from "@/platform/py/unicode";
import { PyError } from "@/platform/py/value";

// The HTML-to-text and date helpers several sources share, so sources never import each other:
// free_jobs.Text (htmlText) and public_feeds.text / published, ported once each.

/** free_jobs.Text: visible text of an HTML fragment, block tags as spaces, script/style dropped. */
export function htmlText(html: string): string {
  const parts: string[] = [];
  let hidden = 0;
  htmlFeed(html, {
    starttag(tag) {
      if (tag === "script" || tag === "style") hidden++;
      if (tag === "p" || tag === "div" || tag === "br" || tag === "li") parts.push(" ");
    },
    endtag(tag) {
      if (tag === "script" || tag === "style") hidden = Math.max(0, hidden - 1);
      if (tag === "p" || tag === "div" || tag === "li") parts.push(" ");
    },
    data(data) {
      if (!hidden) parts.push(data);
    },
  });
  return parts.join("");
}

/** public_feeds.Text: visible text, block tags as line breaks, script/style dropped; feed() then close(). */
function visibleText(html: string): string {
  const parts: string[] = [];
  let hidden = 0;
  htmlFeed(html, {
    starttag(tag) {
      if (tag === "script" || tag === "style") hidden++;
      if (["p", "div", "br", "li", "h1", "h2", "h3", "tr"].includes(tag)) parts.push("\n");
    },
    endtag(tag) {
      if (tag === "script" || tag === "style") hidden = Math.max(0, hidden - 1);
      if (["p", "div", "li", "h1", "h2", "h3", "tr"].includes(tag)) parts.push("\n");
    },
    data(data) {
      if (!hidden) parts.push(data);
    },
  }, true);
  return parts.join("");
}

/** public_feeds.text */
export function text(value: unknown): string {
  if (typeof value !== "string" || !pyStrip(value) || pyLen(value) > 200_000) throw new PyError("ValueError", "Full feed description required");
  const result = pySplitlines(visibleText(value)).filter((line) => pyStrip(line)).map((line) => pySplit(line).join(" ")).join("\n");
  if (!result) throw new PyError("ValueError", "Empty text");
  return result;
}

/** public_feeds.published: an aware time in UTC. */
export function published(value: unknown): PyDateTime {
  if (typeof value !== "string") throw new PyError("ValueError", "Publication time required");
  let result: PyDateTime;
  try {
    result = fromisoformat(value.replaceAll("Z", "+00:00"));
  } catch (e) {
    if (!(e instanceof PyError && e.pyType === "ValueError")) throw e;
    result = parsedateToDatetime(value);
  }
  if (!result.aware) throw new PyError("ValueError", "Publication timezone required");
  try {
    return PyDateTime.fromUtcMicros(result.utcMicros());
  } catch {
    throw new PyError("OverflowError", "date value out of range");
  }
}

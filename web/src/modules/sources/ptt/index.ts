import { load } from "cheerio";
import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { boardUrl, pageHtml, PAGE_BYTES, PAGE_TIMEOUT_MS, readDetails, USER_AGENT } from "../shared/job-pages";
import { codePoints } from "../shared/json";
import { collapseSpaces, visibleLines } from "../shared/text";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// Two PTT boards read from their public web pages (plan step 8a; old collection/ptt_soho.py and
// ptt_codejob.py at ce1254d): SOHO and CodeJob. No account, no comments, no links out of the board.
// Both boards answer a plain request from the VM without the over18 cookie (spike 2; checked again
// 2026-11-16), so no cookie is sent.
//
// Read scope (old): the newest index page and the one before it; of their posts, those whose title has
// the board's job prefix and whose id time is within the last 90 days. Each such post's page is read,
// open posts newest first, then posts closed by their title, at most MAX_ARTICLES (old: 20 open posts
// after the title rule, closed ones only updated rows already stored; D9 stores every post in scope, so
// the title rule moved to sourceKept and the cap was doubled). More posts in scope than the cap, or the
// request cap reached, marks the read truncated. A newest page without the link to the page before, or
// with post links none of which is this board's, fails the source. A post page without the article, with a body under 5 or over 100,000 code points,
// is set aside and counted (shared/job-pages readDetails); an index page without the post list fails the
// source (an over18 or challenge page has none).
//
// Times: the post id is `M.<unix seconds>.A.<hex>.html`; that second is published_at (UTC, old).
// Closed: a closing word in the title or at the start of a body line (old CLOSED, BODY_CLOSED) sets
// listing_closed; "徵到為止" is not one. Kind: SOHO is contract (old); CodeJob reads employment evidence
// (old employment_kind). Budget, hours, eligibility and deadline are unknown (D8).
//
// The source's rule (old intake filter, D9 sourceKept): SOHO keeps posts whose title names technical
// work (old TECH); CodeJob has none beyond the prefix.

const ORIGIN = "https://www.ptt.cc";
const HOST = "www.ptt.cc";
const DAY_MS = 86_400_000;
const INDEX_PAGES = 2;
export const MAX_ARTICLES = 40;

type Board = {
  name: string;
  label: string;
  board: string;
  /** The title prefixes of a post asking for work (old INDEX filter). */
  demand: RegExp;
  closedTitle: RegExp;
  closedBody: RegExp;
  kind: (title: string, body: string) => ListingInput["kind"];
  kept: (l: ListingInput) => boolean;
  /** `/bbs/<board>/M.<seconds>.A.<hex>.html`: groups 1 the id, 2 the seconds. */
  article: RegExp;
  index: RegExp;
};

const patterns = (board: string) => ({
  article: new RegExp(`^/bbs/${board}/(M\\.(\\d{10})\\.A\\.[A-Fa-f0-9]+\\.html)$`),
  index: new RegExp(`^/bbs/${board}/index(?:\\d+)?\\.html$`),
});

// Python's \b and [a-z0-9] lookarounds with re.I; \b on Unicode word characters as Python's str patterns.
const W = String.raw`[\p{L}\p{N}_]`;
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const re = (pattern: string, flags = "iu") => new RegExp(pattern.replaceAll("\\b", B), flags);

const TECH = re(String.raw`AI\s*agent|agentic|自動化|後端|前端|全端|網站|網頁|程式|系統開發|WordPress|(?<![a-z0-9])(?:API|LLM|RAG|backend|fullstack|Python|React|Flutter)(?![a-z0-9])`);
const CLOSED_WORDS = "已徵到|已徵得|已找到|已結案|已結束|停止徵求|已額滿";
const LINE_START = String.raw`^\s*(?:[【\[(（]?更新[】\])）：:]?\s*)?(?:本案|此案)?\s*`;

const FULL_TIME = re(String.raw`全職|\bfull[ -]?time\b`);
const NEGATED_FULL_TIME = re(String.raw`(?:非|不是|不用|不需(?:要)?|無需)\s*全職|\b(?:not|non)(?:[ -]+a)?[ -]+full[ -]?time\b`, "giu");
const OPTIONAL_EMPLOYMENT = re(String.raw`全職\s*(?:亦可|也可)|兼職\s*(?:亦可|也可|皆可|可)|全職\s*(?:或|/|／)\s*兼職|\b(?:full[ -]?time\s*(?:or|/)\s*part[ -]?time|part[ -]?time\s*(?:or|/)\s*full[ -]?time)\b`);
const BODY_EMPLOYMENT = re(String.raw`(?:職務性質|工作性質|合作型態)[：:]\s*全職|(?:這是|本職缺為|招聘|徵求|招募|徵聘)\s*(?:一位|一名)?\s*全職|\bfull[ -]?time\s+(?:role|position|job|employment)\b`);

/** Old employment_kind: explicit evidence within one clause; a negated or optional full-time clause says nothing. */
export function employmentKind(title: string, body: string): ListingInput["kind"] {
  for (const [text, isTitle] of [[title, true], [body, false]] as const) {
    for (const raw of text.split(/[\n。；;，,]/u)) {
      const clause = raw.replace(NEGATED_FULL_TIME, "");
      if (OPTIONAL_EMPLOYMENT.test(clause)) continue;
      if ((isTitle ? FULL_TIME : BODY_EMPLOYMENT).test(clause)) return "full_time";
    }
  }
  return "contract";
}

export const SOHO: Board = {
  name: "ptt_soho", label: "PTT SOHO", board: "soho", ...patterns("soho"),
  demand: /^\[徵才\]/u,
  closedTitle: new RegExp(CLOSED_WORDS, "u"),
  closedBody: new RegExp(`${LINE_START}(?:${CLOSED_WORDS})`, "mu"),
  kind: () => "contract",
  kept: (l) => TECH.test(l.title),
};

export const CODEJOB: Board = {
  name: "ptt_codejob", label: "PTT CodeJob", board: "CodeJob", ...patterns("CodeJob"),
  demand: /^\[(?:發案|發包|徵才|已解決|解決|已結案|結案)\]/u,
  closedTitle: new RegExp(`${CLOSED_WORDS}|已解決|[\\[（(【](?:結案|解決)[\\]）)】]`, "u"),
  closedBody: new RegExp(`${LINE_START}(?:${CLOSED_WORDS}|已解決|結案(?:$|[。！!]))`, "mu"),
  kind: employmentKind,
  kept: () => true,
};

/** The post's URL on the board, or null when the link is not one of this board's posts. */
export const postUrl = (b: Board, value: unknown) => boardUrl(ORIGIN, HOST, b.article, value);

export type Entry = { url: string; external_id: string; title: string; published_at: string; closedTitle: boolean };

/**
 * The in-scope posts of one index page and the path of the page before it. Throws SourceError without the
 * post list, or when the page lists post links and none of them is one of this board's posts (a changed link
 * format must fail the source, not read as an empty board).
 */
export function parseIndex(b: Board, raw: Uint8Array, now: Date): { entries: Entry[]; previous: string | null } {
  const $ = load(pageHtml(b.name, raw), { scriptingEnabled: false });
  if (!$(".r-list-container").length) throw new SourceError(`${b.name}: post list missing`);
  let previous: string | null = null;
  $("a").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    if ($(a).text().includes("上頁") && b.index.test(href)) previous = href;
  });
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const links = $(".r-ent .title a").toArray();
  let posts = 0;
  for (const a of links) {
    const url = postUrl(b, $(a).attr("href"));
    if (url === null) continue;
    posts++;
    if (seen.has(url)) continue;
    const title = collapseSpaces($(a).text());
    if (!b.demand.test(title)) continue;
    const [, id, seconds] = b.article.exec(new URL(url).pathname) ?? [];
    const published = Number(seconds) * 1000;
    if (published < now.getTime() - 90 * DAY_MS || published > now.getTime()) continue;
    seen.add(url);
    entries.push({ url, external_id: id, title, published_at: new Date(published).toISOString(), closedTitle: b.closedTitle.test(title) });
  }
  if (links.length > 0 && posts === 0) throw new SourceError(`${b.name}: no post link recognized`);
  return { entries, previous };
}

/** One post page in the contract; throws SourceError without the article or with a body out of bounds. */
export function parseArticle(b: Board, raw: Uint8Array, entry: Entry): ListingInput {
  if (postUrl(b, entry.url) !== entry.url) throw new SourceError(`${b.name}: invalid post URL`);
  const $ = load(pageHtml(b.name, raw), { scriptingEnabled: false });
  const main = $("#main-content");
  if (!main.length) throw new SourceError(`${b.name}: article missing`);
  // Author, board, time and IP lines, comments and the site's "※" notes (sent from, edited, URL) are not
  // the post. Class f2 is also any green text the poster colored, so only the "※" notes are removed.
  main.find(".article-metaline, .article-metaline-right, .push, script, style").remove();
  main.find(".f2").filter((_, el) => $(el).text().trimStart().startsWith("※")).remove();
  const body = visibleLines(main.html() ?? "");
  if (codePoints(body) < 5 || codePoints(body) > 100_000) throw new SourceError(`${b.name}: invalid body`);
  return parseListingInput({
    external_id: entry.external_id, title: entry.title, description: body, url: entry.url, canonical_url: entry.url,
    kind: b.kind(entry.title, body), complete: true, listing_closed: entry.closedTitle || b.closedBody.test(body),
    published_at: entry.published_at, extra: { language: "zh-TW" },
  });
}

const page = (fetcher: Fetcher, url: string) => fetcher.get({ url, maxBytes: PAGE_BYTES, timeoutMs: PAGE_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT } });

export async function pttConnector(b: Board, fetcher: Fetcher, now: Date): Promise<Collected> {
  const byId = new Map<string, Entry>();
  let path: string | null = `/bbs/${b.board}/index.html`;
  const visited = new Set<string>();
  for (let i = 0; i < INDEX_PAGES && path !== null && !visited.has(path); i++) {
    visited.add(path);
    const { entries, previous } = parseIndex(b, (await page(fetcher, ORIGIN + path)).body, now);
    for (const e of entries) if (!byId.has(e.external_id)) byId.set(e.external_id, e);
    // The newest page always links to the one before; without it the read would quietly shrink to one page.
    if (i === 0 && previous === null) throw new SourceError(`${b.name}: previous page link missing`);
    path = previous;
  }
  // Open posts first, newest first; posts closed by their title (CodeJob's [已解決] and the like) only
  // after them, so they never use up the read before an open post.
  const inScope = [...byId.values()].sort((x, y) => Number(x.closedTitle) - Number(y.closedTitle) || y.published_at.localeCompare(x.published_at));
  const read = await readDetails(inScope.slice(0, MAX_ARTICLES), async (e) => parseArticle(b, (await page(fetcher, e.url)).body, e));
  return { seen: inScope.length, ...read, truncated: read.truncated || inScope.length > MAX_ARTICLES, sourceKept: b.kept };
}

const settings = (b: Board): Omit<PageSourceSettings, "order"> => ({
  opportunityType: "job",
  name: b.name, label: b.label, connector: (fetcher, now) => pttConnector(b, fetcher, now), maxTier: "plain",
  minIntervalMs: 1_000, maxRequestsPerRun: INDEX_PAGES + MAX_ARTICLES, completeRead: false, disabled: null,
});

export const PTT_SOHO_SETTINGS = settings(SOHO);
export const PTT_CODEJOB_SETTINGS = settings(CODEJOB);

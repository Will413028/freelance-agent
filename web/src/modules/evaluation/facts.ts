import { escapeRegExp } from "@/platform/text";
import type { CATEGORIES as CATEGORY_NAMES } from "@/db/pg/schema";
import { deadlineAt, type Listing } from "./listing";

// The evaluation facts that depend on neither the settings nor the time, computed once when a
// listing is written and stored as its columns (step-3-design.md core choice 1). The rules are those
// of the old qualify/recommendation (web/src/modules/discovery/domain.ts, ranking.ts), over typed
// fields (plan D8).

export type Category = (typeof CATEGORY_NAMES)[number] | "其他";

const CATEGORIES: readonly (readonly [(typeof CATEGORY_NAMES)[number], number, readonly string[]])[] = [
  ["AI agent", 95, ["ai agent", "agentic", "tool calling", "智能代理", "智慧代理"]],
  ["AI 整合／自動化", 85, ["rag", "llm", "automation", "自動化", "自动化", "聊天機器人", "聊天机器人", "ai 整合"]],
  ["全端 MVP", 70, ["fullstack", "full-stack", "mvp", "website", "全端", "全栈", "網站", "网站", "會員"]],
  ["後端／API", 75, ["backend", "api", "後端", "后端", "串接"]],
];

export type Facts = {
  category: Category;
  categoryScore: number;
  /** A reason that excludes the listing whatever the settings and the time. */
  hardExcluded: boolean;
  /** How many of Taiwan eligibility, time zone and complete requirements are confirmed true. */
  confirmedBase: number;
  /** The upper budget when the listing is a fixed-price TWD job with a valid range; null otherwise. */
  fixedTwdMax: number | null;
  publishedAt: Date | null;
  deadlineAt: Date | null;
};

const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);

export function categorize(l: Pick<Listing, "title" | "description">): { category: Category; categoryScore: number } {
  const text = `${l.title} ${l.description ?? ""}`.toLowerCase();
  const contains = (term: string) =>
    isAscii(term) ? new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`).test(text) : text.includes(term);
  let best: (typeof CATEGORIES)[number] | null = null;
  for (const c of CATEGORIES) if (c[2].some(contains) && (!best || c[1] > best[1])) best = c;
  return best ? { category: best[0], categoryScore: best[1] } : { category: "其他", categoryScore: 0 };
}

/** A fixed-price budget range is usable when the upper bound is positive and the lower, if given, lies in [0, upper]. */
export const validBudget = (l: Pick<Listing, "budgetMin" | "budgetMax">) =>
  l.budgetMax !== null && l.budgetMax > 0 && (l.budgetMin === null || (l.budgetMin >= 0 && l.budgetMin <= l.budgetMax));

export const fixedTwdMax = (l: Listing): number | null =>
  l.kind === "fixed" && l.currency === "TWD" && validBudget(l) ? l.budgetMax : null;

/**
 * The version of the rules factsOf applies (plan D26). Stored rows carry the version they were evaluated
 * with; the daily run re-evaluates rows of any other version. Bump it with any change to what factsOf
 * returns for the same listing (categories, keywords, exclusions, deadline rule); facts.test.ts pins the
 * version to a digest of factsOf over the evaluate fixtures and fails until both are updated together. The
 * digest only sees what those fixtures exercise: a keyword or exclusion no fixture hits changes nothing there,
 * so a rule change also adds a fixture case that it changes (or bumps the version by hand).
 */
export const FACTS_VERSION = 1;

export function factsOf(l: Listing): Facts {
  const { category, categoryScore } = categorize(l);
  const hardExcluded = l.listingClosed === true
    || l.compensationEvidence === "unpaid_or_equity_only"
    || categoryScore === 0
    || l.kind === "full_time"
    || l.taiwanEligible === false
    || l.timezoneCompatible === false;
  const confirmedBase = [l.taiwanEligible, l.timezoneCompatible, l.complete].filter((v) => v === true).length;
  return { category, categoryScore, hardExcluded, confirmedBase, fixedTwdMax: fixedTwdMax(l), publishedAt: l.publishedAt, deadlineAt: deadlineAt(l.deadline) };
}

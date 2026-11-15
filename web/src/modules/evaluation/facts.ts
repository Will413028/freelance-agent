import { CATEGORIES as CATEGORY_NAMES, KINDS } from "@/db/pg/schema";
import { parseIsoTime, taipeiDayAfter } from "./time";

// The evaluation facts that depend on neither the settings nor the time, computed once when a
// listing is written and stored as its columns (step-3-design.md core choice 1). The rules are those
// of the old qualify/recommendation (web/src/modules/discovery/domain.ts, ranking.ts).

/** A listing as a source gives it: JSON, every field optional, unknown kept as absent or null. */
export type Job = Readonly<Record<string, unknown>>;

export type Category = (typeof CATEGORY_NAMES)[number] | "其他";

const CATEGORIES: readonly (readonly [(typeof CATEGORY_NAMES)[number], number, readonly string[]])[] = [
  ["AI agent", 95, ["ai agent", "agentic", "tool calling", "智能代理", "智慧代理"]],
  ["AI 整合／自動化", 85, ["rag", "llm", "automation", "自動化", "自动化", "聊天機器人", "聊天机器人", "ai 整合"]],
  ["全端 MVP", 70, ["fullstack", "full-stack", "mvp", "website", "全端", "全栈", "網站", "网站", "會員"]],
  ["後端／API", 75, ["backend", "api", "後端", "后端", "串接"]],
];

export type Kind = (typeof KINDS)[number];

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

export const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);

export function categorize(job: Job): { category: Category; categoryScore: number } {
  const text = `${str(job.title) ?? ""} ${str(job.description) ?? ""}`.toLowerCase();
  const contains = (term: string) =>
    isAscii(term) ? new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`).test(text) : text.includes(term);
  let best: (typeof CATEGORIES)[number] | null = null;
  for (const c of CATEGORIES) if (c[2].some(contains) && (!best || c[1] > best[1])) best = c;
  return best ? { category: best[0], categoryScore: best[1] } : { category: "其他", categoryScore: 0 };
}

export const kindOf = (job: Job): Kind | null => (typeof job.kind === "string" && (KINDS as readonly string[]).includes(job.kind) ? (job.kind as Kind) : null);

export function fixedTwdMax(job: Job): number | null {
  if (job.kind !== "fixed" || job.currency !== "TWD") return null;
  const high = num(job.budget_max), low = job.budget_min ?? null;
  if (high === null || high <= 0) return null;
  if (low !== null && (num(low) === null || (low as number) < 0 || (low as number) > high)) return null;
  return high;
}

/** A deadline's expiry instant: aware text at its instant, a date at the next Asia/Taipei midnight; null when absent, naive or invalid. */
export function deadlineAt(job: Job): Date | null {
  const text = str(job.deadline);
  if (!text) return null;
  const parsed = parseIsoTime(text.replaceAll("Z", "+00:00"));
  if (!parsed || parsed.kind === "naive") return null;
  return parsed.kind === "date" ? taipeiDayAfter(parsed.year, parsed.month, parsed.day) : parsed.instant;
}

const PUBLISHED_FROM_RECEIVED = ["himalayas", "hackernews", "v2ex"];
const PUBLISHED_FROM_EVIDENCE = ["jobicy", "remotive"];

/** When the listing was published; null when unknown. Naive text counts as UTC only for the evidence fallback of jobicy and remotive. */
export function publishedAt(source: string, job: Job): Date | null {
  let value: unknown = job.published_at ?? null;
  let assumeUtc = false;
  if (value === null && PUBLISHED_FROM_RECEIVED.includes(source)) value = job.received_at ?? null;
  if (value === null && PUBLISHED_FROM_EVIDENCE.includes(source)) {
    value = job.publication_evidence ?? null;
    assumeUtc = true;
  }
  if (typeof value === "number") {
    const d = new Date(value * 1000);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value !== "string") return null;
  const parsed = parseIsoTime(value.replaceAll("Z", "+00:00"));
  if (!parsed) return null;
  if (parsed.kind === "aware") return parsed.instant;
  if (parsed.kind === "naive") return assumeUtc ? parsed.utcIfAssumed : null;
  return assumeUtc ? new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)) : null;
}

export function factsOf(source: string, job: Job): Facts {
  const { category, categoryScore } = categorize(job);
  const hardExcluded = job.listing_closed === true
    || job.compensation_evidence === "unpaid_or_equity_only"
    || categoryScore === 0
    || job.kind === "full_time"
    || job.taiwan_eligible === false
    || job.timezone_compatible === false;
  const confirmedBase = [job.taiwan_eligible, job.timezone_compatible, job.complete].filter((v) => bool(v) === true).length;
  return { category, categoryScore, hardExcluded, confirmedBase, fixedTwdMax: fixedTwdMax(job), publishedAt: publishedAt(source, job), deadlineAt: deadlineAt(job) };
}

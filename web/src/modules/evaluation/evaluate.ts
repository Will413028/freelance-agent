import { categorize, factsOf, validBudget, type Category } from "./facts";
import type { Listing } from "./listing";
import { excluded, expired, freshTenths, hoursOk, optionTenths, type FeedbackState, type RankFacts, type Settings } from "./rank";

// The evaluation with its wording, for the listings a page shows (step-3-design.md core choice 1):
// the rules and texts of the old evaluate and recommendation (web/src/modules/discovery/domain.ts,
// rules.ts, ranking.ts) over the typed Listing (plan D8). Its verdicts come from rank.ts over factsOf, so the page's
// words and the list's order cannot disagree; evaluate.fixtures.json and recommendation.fixtures.json
// hold the cases carried over from golden.json.

export type Status = "qualified" | "needs_info" | "excluded";
export type Evaluation = { status: Status; category: Category; score: number; reasons: string[]; questions: string[] };

/** Python's %g: six significant digits, trailing zeros dropped, exponent form outside 1e-4 ≤ |x| < 1e6. */
export function formatG(x: number): string {
  if (x === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(Number(x.toPrecision(6)))));
  if (exp < -4 || exp >= 6) {
    const [m, e] = x.toExponential(5).split("e");
    return `${m.replace(/\.?0+$/, "")}e${e[0]}${e.slice(1).padStart(2, "0")}`;
  }
  return x.toPrecision(6).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** Python's `{:,.0f}`: round half to even, thousands separated by commas. */
function thousands(x: number): string {
  const floor = Math.floor(x), rounded = x - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(x);
  return rounded.toLocaleString("en-US");
}

const DEADLINE_QUESTIONS = { none: "確認申請截止時間與交付時程", no_timezone: "確認截止時間的時區", invalid: "確認有效的截止日期" } as const;

function deadlineQuestion(l: Listing): string | null {
  if (l.deadline === null) return DEADLINE_QUESTIONS.none;
  return l.deadline.kind === "no_timezone" || l.deadline.kind === "invalid" ? DEADLINE_QUESTIONS[l.deadline.kind] : null;
}

/** The old evaluate: status, category, category score, reasons and open questions, in their order. */
export function evaluate(l: Listing, s: Settings, now: Date): Evaluation {
  const { category, categoryScore } = categorize(l);
  const f = factsOf(l);
  const reasons: string[] = [], questions: string[] = [];
  if (l.listingClosed === true) reasons.push("來源已標示結案或已徵到");
  if (l.compensationEvidence === "unpaid_or_equity_only") reasons.push("來源明示無薪或僅股權，不符合接案收入需求");
  if (categoryScore === 0) reasons.push("不在目前接案專長範圍");
  if (l.kind === "full_time") reasons.push("全職職缺不符目前接案安排");
  else if (l.kind === null) questions.push("確認合作型態");
  for (const [value, label] of [[l.taiwanEligible, "台灣接案資格"], [l.timezoneCompatible, "時區重疊要求"]] as const) {
    if (value === false) reasons.push(`${label}不符`);
    else if (value === null) questions.push(`確認${label}`);
  }
  const hours = l.weeklyHours;
  if (hours === null || hours <= 0) questions.push("確認每週工時，需包含溝通與修改");
  else if (s.maxWeeklyHours !== null && hours > s.maxWeeklyHours) {
    reasons.push(`每週需求 ${formatG(hours)} 小時，超過目前可排 ${formatG(s.maxWeeklyHours)} 小時`);
  }
  if (l.kind === "fixed") {
    if (!validBudget(l)) questions.push("確認有效的單案預算區間");
    else if (l.currency !== "TWD") questions.push("確認外幣換算匯率及日期");
    else if (l.budgetMax! < s.minFixedTwd) reasons.push(`預算上限低於單案底價 TWD ${thousands(s.minFixedTwd)}`);
    else if (l.budgetMin === null || l.budgetMin < s.minFixedTwd) questions.push(`確認實際報價至少 TWD ${thousands(s.minFixedTwd)}`);
  } else if (l.kind === "hourly" || l.kind === "contract") {
    questions.push("確認目標時薪與合約報酬，不套用單案總價門檻");
  }
  const dq = deadlineQuestion(l);
  if (dq) questions.push(dq);
  if (l.complete !== true) questions.push("取得完整需求；通知摘要不足以承諾報價與交期");
  if (expired(f, now)) reasons.push("申請已過期");
  if (!reasons.length && !(s.categories as readonly string[]).includes(category)) reasons.push("不在目前選擇的專長分類");
  return { status: reasons.length ? "excluded" : questions.length ? "needs_info" : "qualified", category, score: categoryScore, reasons, questions };
}

/** One content as ranking reads it, from its JSON. */
export const rankFactsOf = (fingerprint: string, l: Listing): RankFacts => ({ ...factsOf(l), fingerprint, weeklyHours: l.weeklyHours });

export type Recommendation = {
  score: number; completeness: number; freshness: "recent" | "week" | "older" | "unknown"; reasons: string[]; basis: string;
};

export type Content = { fingerprint: string; listing: Listing };

function single(c: Content, e: Evaluation, feedback: FeedbackState, s: Settings, now: Date): Recommendation & { tenths: number } {
  const l = c.listing, f = rankFactsOf(c.fingerprint, l);
  const reasons = [`專長匹配：${e.category}`];
  if (feedback === "interested") reasons.push("你已標記想接");
  const published = l.publishedAt, fresh = freshTenths(published, now);
  const freshness = published === null ? "unknown" : fresh === 100 ? "recent" : fresh === 60 ? "week" : now.getTime() < published.getTime() ? "unknown" : "older";
  reasons.push({ recent: "近兩日發布", week: "近七日發布", older: "發布超過七日", unknown: "發布時間未確認，不以收信時間代替" }[freshness]);
  const fields = [
    l.taiwanEligible === true, l.timezoneCompatible === true, hoursOk(f, s), l.complete === true,
    l.kind === "fixed" && l.currency === "TWD" && l.budgetMin !== null && l.budgetMax !== null && s.minFixedTwd <= l.budgetMin && l.budgetMin <= l.budgetMax,
    l.deadline?.kind === "date" || l.deadline?.kind === "instant",
  ];
  const completeness = Math.round((fields.filter(Boolean).length / fields.length) * 100);
  reasons.push(`資訊完整度 ${completeness}%（非資格保證）`);
  if (e.status === "excluded") reasons.push("硬條件不符，仍不推薦");
  const tenths = optionTenths(f, s, now);
  return { score: Math.min(1000, tenths + (feedback === "interested" ? 100 : 0)) / 10, completeness, freshness, reasons, basis: c.fingerprint, tenths };
}

/**
 * The old recommendation over a listing and its versions: the best still-possible content gives the
 * score and the reasons; when none is possible, the listing's own. The score equals rank()'s.
 */
export function recommend(listing: Content, versions: readonly Content[], feedback: FeedbackState, s: Settings, now: Date): Recommendation {
  const options = [listing, ...versions.filter((v) => v.fingerprint !== listing.fingerprint)];
  const possible = options.filter((o) => !excluded(rankFactsOf(o.fingerprint, o.listing), s, now));
  // Compared before the saved bonus and its cap, as rank() compares, so both pick the same content.
  let best: (Recommendation & { tenths: number }) | null = null;
  for (const o of possible.length ? possible : [listing]) {
    const r = single(o, evaluate(o.listing, s, now), feedback, s, now);
    if (!best || r.tenths > best.tenths) best = r;
  }
  if (versions.length) best!.reasons.push("通知內容有差異；依可能符合的一份排序，需核對原文");
  const { tenths: _, ...shown } = best!;
  return shown;
}


import { fromisoformat, type PyDateTime } from "@/platform/py/datetime";
import { formatG, formatThousands0f } from "@/platform/py/format";
import { isAscii } from "@/platform/py/unicode";
import { isNumber, num, pyCmp, pyEq, PyDict, PyError, truthy, type PyValue } from "@/platform/py/value";

// Port of backend/src/freelance/modules/discovery/domain.py. Output text is stored in opportunity
// rows, so wording, number formatting and list order must match the Python writer byte for byte.

export const DEFAULT_HOURS = 30n;

export const number = isNumber;

type Category = [name: string, score: bigint, terms: string[], portfolioIds: string[]];
const CATEGORIES: Category[] = [
  ["AI agent", 95n, ["ai agent", "agentic", "tool calling", "智能代理", "智慧代理"], ["agent-project", "team-product"]],
  ["AI 整合／自動化", 85n, ["rag", "llm", "automation", "自動化", "自动化", "聊天機器人", "聊天机器人", "ai 整合"], ["agent-project", "team-product"]],
  ["全端 MVP", 70n, ["fullstack", "full-stack", "mvp", "website", "全端", "全栈", "網站", "网站", "會員"], ["booking-demo", "side-project"]],
  ["後端／API", 75n, ["backend", "api", "後端", "后端", "串接"], ["team-product"]],
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** job.get(key, '') that must be a str for the `+` in Python to succeed. */
function strField(job: PyDict, key: string): string {
  const v = job.has(key) ? job.get(key)! : "";
  if (typeof v !== "string") throw new PyError("TypeError", `can only concatenate str (not "${v === null ? "NoneType" : typeof v}") to str`);
  return v;
}

const gt = (a: PyValue, b: PyValue) => pyCmp(a, b) > 0;
const lt = (a: PyValue, b: PyValue) => pyCmp(a, b) < 0;

export function qualify(job: PyDict, availableHours: PyValue, now: PyDateTime, minimumBudget: PyValue): PyDict {
  const reasons: string[] = [], questions: string[] = [];
  // str.lower() and toLowerCase() differ only on non-ASCII mappings across Unicode versions; the
  // ASCII terms match on [a-z0-9] boundaries and the CJK terms are caseless, so matches are equal.
  const text = (strField(job, "title") + " " + strField(job, "description")).toLowerCase();
  const contains = (term: string) =>
    isAscii(term) ? new RegExp("(?<![a-z0-9])" + escapeRegExp(term) + "(?![a-z0-9])").test(text) : text.includes(term);

  const matches = CATEGORIES.filter(([, , terms]) => terms.some(contains));
  let best: Category | null = null;
  for (const m of matches) if (!best || m[1] > best[1]) best = m;
  const [category, score, , portfolioIds] = best ?? ["其他", 0n, [], []];

  if (job.at("listing_closed") === true) reasons.push("來源已標示結案或已徵到");
  if (pyEq(job.at("compensation_evidence"), "unpaid_or_equity_only")) reasons.push("來源明示無薪或僅股權，不符合接案收入需求");
  if (!matches.length) reasons.push("不在目前接案專長範圍");
  const kind = job.at("kind");
  if (pyEq(kind, "full_time")) reasons.push("全職職缺不符目前接案安排");
  else if (!["fixed", "hourly", "contract"].some((k) => pyEq(kind, k))) questions.push("確認合作型態");
  for (const [key, label] of [["taiwan_eligible", "台灣接案資格"], ["timezone_compatible", "時區重疊要求"]]) {
    const v = job.at(key);
    if (v === false) reasons.push(`${label}不符`);
    else if (v !== true) questions.push(`確認${label}`);
  }
  const hours = job.at("weekly_hours");
  if (!isNumber(hours) || !gt(hours, 0n)) questions.push("確認每週工時，需包含溝通與修改");
  else if (availableHours !== null && gt(hours, availableHours)) {
    reasons.push(`每週需求 ${formatG(num(hours))} 小時，超過目前可排 ${formatG(num(availableHours))} 小時`);
  }
  if (pyEq(kind, "fixed")) {
    const low = job.at("budget_min"), high = job.at("budget_max");
    if (!isNumber(high) || !gt(high, 0n) || (low !== null && (!isNumber(low) || lt(low, 0n) || gt(low, high)))) {
      questions.push("確認有效的單案預算區間");
    } else if (!pyEq(job.at("currency"), "TWD")) questions.push("確認外幣換算匯率及日期");
    else if (lt(high, minimumBudget)) reasons.push(`預算上限低於單案底價 TWD ${formatThousands0f(num(minimumBudget))}`);
    else if (low === null || lt(low, minimumBudget)) questions.push(`確認實際報價至少 TWD ${formatThousands0f(num(minimumBudget))}`);
  } else if (pyEq(kind, "hourly") || pyEq(kind, "contract")) {
    questions.push("確認目標時薪與合約報酬，不套用單案總價門檻");
  }
  const deadline = job.at("deadline");
  if (!truthy(deadline)) questions.push("確認申請截止時間與交付時程");
  else {
    try {
      if (typeof deadline !== "string") throw new PyError("AttributeError", "deadline has no replace");
      const parsed = fromisoformat(deadline.replaceAll("Z", "+00:00"));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) && !parsed.aware) questions.push("確認截止時間的時區");
      else if (parsed.aware ? parsed.utcMicros() <= now.utcMicros() : parsed.dateOrdinal() < now.dateOrdinal()) {
        reasons.push("申請已過期");
      }
    } catch (e) {
      if (!(e instanceof PyError) || !["ValueError", "AttributeError"].includes(e.pyType)) throw e;
      questions.push("確認有效的截止日期");
    }
  }
  if (job.at("complete") !== true) questions.push("取得完整需求；通知摘要不足以承諾報價與交期");
  return PyDict.of({
    status: reasons.length ? "excluded" : questions.length ? "needs_info" : "qualified",
    category, score, reasons, questions, portfolio_ids: [...portfolioIds], method: "規則評估", available_hours: availableHours,
  });
}

/** Personal price/hour limits belong to the saved view, not permanent intake loss. */
export const qualifyForIntake = (job: PyDict, now: PyDateTime) => qualify(job, null, now, 0n);

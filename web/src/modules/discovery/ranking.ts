import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { roundFloat, roundToInt } from "@/platform/py/format";
import { pyStr } from "@/platform/py/unicode";
import { asDict, asList, isNumber, num, pyCmp, pyEq, PyDict, PyError, truthy, type PyValue } from "@/platform/py/value";

// Port of backend/src/freelance/modules/discovery/ranking.py: explainable prioritization that never
// changes qualification or invents evidence.

const tracking = (item: PyDict) => (item.has("tracking") ? asDict(item.get("tracking")!) : new PyDict());
const conflicts = (item: PyDict): PyValue[] => (item.has("content_conflicts") ? asList(item.get("content_conflicts")!) : []);
const versionsOf = (item: PyDict) => conflicts(item).flatMap((c) => asList(asDict(c).req("versions")).map(asDict));

export function isCandidate(item: PyDict): boolean {
  const t = tracking(item);
  const possible = item.dict("evaluation").req("status") !== "excluded"
    || versionsOf(item).some((v) => v.dict("evaluation").req("status") !== "excluded");
  return possible
    && !truthy(item.at("application_ids"))
    && !["skipped", "sent", "delivered"].some((s) => pyEq(item.req("review_status"), s))
    && !pyEq(t.at("feedback"), "skipped")
    && pyEq(t.has("stage") ? t.get("stage")! : "not_applied", "not_applied");
}

const PUBLISHED_FROM_RECEIVED = ["himalayas", "hackernews", "v2ex"];
const PUBLISHED_FROM_EVIDENCE = ["jobicy", "remotive"];
const isOneOf = (v: PyValue, list: string[]) => list.some((s) => pyEq(v, s));

/** The documented conditions an option meets (Taiwan eligibility, time zone, hours within the limit, complete). */
function confirmedFields(job: PyDict, evaluation: PyDict): boolean[] {
  const hours = job.at("weekly_hours"), available = evaluation.req("available_hours");
  return [
    job.at("taiwan_eligible") === true,
    job.at("timezone_compatible") === true,
    isNumber(hours) && pyCmp(hours, 0n) > 0 && (available === null || pyCmp(hours, available) <= 0),
    job.at("complete") === true,
  ];
}

export const confirmedCount = (job: PyDict, evaluation: PyDict) => confirmedFields(job, evaluation).filter(Boolean).length;

/** When the listing was published, aware, or null when that is unknown. Known parser contracts use received_at for publication; Tasker never does. */
export function publishedAt(job: PyDict): PyDateTime | null {
  try {
    let value = job.at("published_at");
    if (value === null && isOneOf(job.at("source"), PUBLISHED_FROM_RECEIVED)) value = job.at("received_at");
    if (value === null && isOneOf(job.at("source"), PUBLISHED_FROM_EVIDENCE)) value = job.at("publication_evidence");
    let published: PyDateTime;
    if (typeof value === "bigint" || typeof value === "number") published = PyDateTime.fromTimestamp(value);
    else {
      if (typeof value !== "string") throw new PyError("AttributeError", "no replace");
      published = fromisoformat(value.replaceAll("Z", "+00:00"));
    }
    if (!published.aware) {
      // Same explicit convention as free_jobs.normalize.
      if (isOneOf(job.at("source"), PUBLISHED_FROM_EVIDENCE) && !truthy(job.at("published_at"))) published = published.withUtc();
      else throw new PyError("ValueError", "Publication timezone unknown");
    }
    return published;
  } catch (e) {
    if (!(e instanceof PyError) || !["ValueError", "TypeError", "AttributeError", "OverflowError", "OSError"].includes(e.pyType)) throw e;
    return null;
  }
}

/** Ages in microseconds up to which a publication counts as recent (≤ 2 days) or of this week (≤ 7 days). */
export const RECENT_US = 2n * 86_400_000_000n;
export const WEEK_US = 7n * 86_400_000_000n;

function recommendationSingle(item: PyDict, now: PyDateTime): PyDict {
  const job = item.dict("job"), evaluation = item.dict("evaluation");
  let score = num(evaluation.req("score")) * 0.7;
  const reasons: PyValue[] = [`專長匹配：${pyStr(evaluation.req("category"))}`];
  const confirmed = confirmedFields(job, evaluation);
  score += confirmed.filter(Boolean).length * 2.5;
  if (pyEq(tracking(item).at("feedback"), "interested")) {
    score += 10;
    reasons.push("你已標記想接");
  }
  let freshness = "unknown";
  const published = publishedAt(job);
  if (published !== null) {
    // (now - published).total_seconds() / 86400 against 2 and 7 days: exact on whole microseconds,
    // which is what the projection's SQL compares (plan step 10e1).
    const age = now.utcMicros() - published.utcMicros();
    if (0n <= age && age <= RECENT_US) { score += 10; freshness = "recent"; reasons.push("近兩日發布"); }
    else if (RECENT_US < age && age <= WEEK_US) { score += 6; freshness = "week"; reasons.push("近七日發布"); }
    else if (age > WEEK_US) { freshness = "older"; reasons.push("發布超過七日"); }
  }
  if (freshness === "unknown") reasons.push("發布時間未確認，不以收信時間代替");
  // Completeness is documented fields, not truth confidence or a win probability.
  const low = job.at("budget_min"), high = job.at("budget_max");
  const budget = pyEq(job.at("kind"), "fixed") && pyEq(job.at("currency"), "TWD") && isNumber(low) && isNumber(high)
    && pyCmp(3000n, low) <= 0 && pyCmp(low, high) <= 0;
  const questions = asList(evaluation.req("questions"));
  const fields = [...confirmed, budget, truthy(job.at("deadline")) && !questions.some((q) => typeof q === "string" && q.includes("截止"))];
  const completeness = roundToInt((fields.filter(Boolean).length / fields.length) * 100);
  reasons.push(`資訊完整度 ${completeness}%（非資格保證）`);
  if (evaluation.req("status") === "excluded") reasons.push("硬條件不符，仍不推薦");
  // min(100, score) returns the int 100 on ties and above, and round(int, 1) stays an int.
  const capped: PyValue = score >= 100 ? 100n : roundFloat(score, 1);
  return PyDict.of({ score: capped, completeness, freshness, reasons, method: "規則排序，非成交機率" });
}

export function recommendation(item: PyDict, now: PyDateTime): PyDict {
  const options = [item];
  for (const version of versionsOf(item)) {
    if (!pyEq(version.req("fingerprint"), item.req("fingerprint"))) {
      options.push(new PyDict(item).update({
        job: version.req("job"), evaluation: version.req("evaluation"), fingerprint: version.req("fingerprint"), content_conflicts: [],
      }));
    }
  }
  const possible = options.filter((o) => o.dict("evaluation").req("status") !== "excluded");
  let best: [PyDict, PyDict] | null = null;
  for (const option of possible.length ? possible : options.slice(0, 1)) {
    const result = recommendationSingle(option, now);
    if (!best || pyCmp(result.req("score"), best[0].req("score")) > 0) best = [result, option];
  }
  const [result, basis] = best!;
  result.set("basis_fingerprint", basis.req("fingerprint"));
  if (truthy(item.at("content_conflicts"))) (result.get("reasons") as PyValue[]).push("通知內容有差異；依可能符合的一份排序，需核對原文");
  return result;
}

export function rankItems(items: PyDict[], now: PyDateTime): PyDict[] {
  for (const item of items) item.set("recommendation", recommendation(item, now));
  return rankOrder(items);
}

/** Items that carry their recommendation, in rank order: candidates first, then higher score, then id. */
export function rankOrder(items: readonly PyDict[]): PyDict[] {
  const key = (x: PyDict): PyValue[] => [!isCandidate(x), negateScore(x.dict("recommendation").req("score")), x.req("id")];
  return [...items].sort((a, b) => pyCmp(key(a), key(b)));
}

const negateScore = (v: PyValue): PyValue => (typeof v === "bigint" ? -v : -(v as number));


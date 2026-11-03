import { InvalidSettings } from "@/platform/errors";
import type { PyDateTime } from "@/platform/py/datetime";
import { identityHash } from "@/platform/py/json";
import { pyLen, pyStr, text } from "@/platform/py/unicode";
import { hostname, urlsplit, urlunsplit, userinfo } from "@/platform/py/url";
import {
  asDict, asList, cmpStr, deepCopy, isDict, isNumber, or, pyCmp, pyEq, PyDict, PyError, pySorted, truthy, TupleSet,
  type PyValue,
} from "@/platform/py/value";
import { DEFAULT_HOURS, expire, qualifyUnexpired, type Unexpired } from "./domain";
import { isCandidate } from "./ranking";

// Port of backend/src/freelance/modules/discovery/rules.py.

export const CATEGORIES = ["AI agent", "AI 整合／自動化", "後端／API", "全端 MVP"] as const;
export const defaults = () => PyDict.of({ max_weekly_hours: DEFAULT_HOURS, min_fixed_twd: 3000n, categories: [...CATEGORIES] });

export const PUBLIC_JOB_FIELDS = new Set([
  "source", "external_id", "title", "company", "description", "url", "canonical_url", "kind", "currency", "budget_min",
  "budget_max", "weekly_hours", "taiwan_eligible", "timezone_compatible", "deadline", "listing_closed", "location",
  "location_evidence", "published_at", "publication_evidence", "complete", "body_available", "observed_amount",
  "compensation_evidence", "language", "remote_scope",
]);

export const publicJob = (job: PyDict) => new PyDict([...job].filter(([k]) => PUBLIC_JOB_FIELDS.has(k)).map(([k, v]) => [k, deepCopy(v)]));

/** Validates discovery preferences; raises ValueError like rules.preferences. */
export function preferences(value: PyValue): PyDict {
  const keys = ["max_weekly_hours", "min_fixed_twd", "categories"];
  if (!isDict(value) || value.size !== keys.length || !keys.every((k) => value.has(k))) throw new InvalidSettings("篩選設定欄位不符");
  const hours = value.get("max_weekly_hours")!, budget = value.get("min_fixed_twd")!, categories = value.get("categories")!;
  if (hours !== null && (!isNumber(hours) || pyCmp(hours, 1n) < 0 || pyCmp(hours, 168n) > 0)) throw new InvalidSettings("工時上限需為 1–168 小時，或不限");
  if (!isNumber(budget) || pyCmp(budget, 0n) < 0 || pyCmp(budget, 10_000_000n) > 0) throw new InvalidSettings("最低固定案預算不符範圍");
  if (!Array.isArray(categories) || !categories.length
      || categories.some((c) => typeof c !== "string" || !(CATEGORIES as readonly string[]).includes(c))
      || new Set(categories).size !== categories.length) {
    throw new InvalidSettings("請至少選擇一種專長分類");
  }
  return deepCopy(value);
}

export const evaluate = (job: PyDict, settings: PyDict, now: PyDateTime): PyDict => evaluationAt(evaluateUnexpired(job, settings), settings, now);

/** The settings-dependent half of evaluate, for a `now` before any deadline (what the projection stores, plan step 10e1). */
export const evaluateUnexpired = (job: PyDict, settings: PyDict): Unexpired =>
  qualifyUnexpired(job, settings.req("max_weekly_hours"), settings.req("min_fixed_twd"));

/** evaluate at `now`: the deadline first, then the category filter, which only applies to what the deadline left possible. */
export function evaluationAt(unexpired: Unexpired, settings: PyDict, now: PyDateTime): PyDict {
  const result = expire(unexpired, now);
  if (outsideCategories(result, settings) && result.get("status") !== "excluded") {
    (result.get("reasons") as PyValue[]).push("不在目前選擇的專長分類");
    result.set("status", "excluded");
  }
  return result;
}

/** Whether the evaluated category is one the settings leave out. */
export const outsideCategories = (result: PyDict, settings: PyDict) => !asList(settings.req("categories")).some((c) => pyEq(c, result.get("category")!));

export const project = (item: PyDict, settings: PyDict, now: PyDateTime): PyDict => withEvaluation(item, evaluate(item.dict("job"), settings, now));

/** A copy of the record with this evaluation; an approved review that is no longer qualified shows as a draft. */
export function withEvaluation(item: PyDict, evaluation: PyDict): PyDict {
  const result = deepCopy(item);
  result.set("evaluation", evaluation);
  if (evaluation.get("status") !== "qualified" && pyEq(result.req("review_status"), "approved")) {
    result.update({ review_status: "draft", approved_hash: null });
  }
  return result;
}

/** rules.identity_keys, sorted (Python returns a set; callers only sort or test membership). */
export function identityKeys(job: PyDict): string[] {
  const keys = new Set<string>();
  const url = or(job.at("canonical_url"), job.at("url"));
  if (typeof url === "string") {
    try {
      const parsed = urlsplit(url), ui = userinfo(parsed.netloc);
      // Query parameters may identify a job; only the fragment is cosmetic.
      if (parsed.scheme === "https" && hostname(parsed.netloc) && !ui.username && !ui.password) {
        keys.add("url:" + urlunsplit({ ...parsed, fragment: "" }));
      }
    } catch (e) {
      if (!(e instanceof PyError)) throw e;
    }
  }
  const company = text(job.at("company")), title = text(job.at("title")), body = text(job.at("description"));
  if (company && title && pyLen(body) >= 80 && job.at("body_available") !== false) {
    keys.add("content:" + identityHash([company, title, body, job.at("kind"), text(or(job.at("location_evidence"), job.at("location")))]));
  }
  return [...keys].sort(cmpStr);
}

const NOVELTY_FIELDS = ["title", "description", "company", "kind", "currency", "budget_min", "budget_max", "weekly_hours",
  "taiwan_eligible", "timezone_compatible", "deadline", "listing_closed", "compensation_evidence"];

const conflictsOf = (item: PyDict): PyValue[] => (item.has("content_conflicts") ? asList(item.get("content_conflicts")!) : []);
export const conflictVersionsOf = (item: PyDict) => conflictsOf(item).flatMap((c) => asList(asDict(c).req("versions")).map(asDict));

export function novelty(item: PyDict): TupleSet {
  if (item.has("novelty_keys")) return new TupleSet(asList(item.get("novelty_keys")!).map((k) => asList(k).map(String)));
  const job = item.dict("job");
  const fingerprint = identityHash(new PyDict(NOVELTY_FIELDS.map((k) => [k, job.at(k)])));
  const observed = new TupleSet([[item.str("id"), item.str("fingerprint")]]);
  for (const version of conflictVersionsOf(item)) observed.add([item.str("id"), version.str("fingerprint")]);
  for (const key of identityKeys(job)) observed.add([key, fingerprint]);
  return observed;
}

const trackingOf = (item: PyDict) => (item.has("tracking") ? asDict(item.get("tracking")!) : new PyDict());
const trackingAt = (item: PyDict, key: string, fallback: PyValue) => {
  const t = trackingOf(item);
  return t.has(key) ? t.get(key)! : fallback;
};

/**
 * Every listing is its own group (D18 A3, plan step 10e2): no merging across sources. The group keeps
 * the shape groups always had (members with revision tokens, observation fingerprints, novelty keys,
 * display basis), so the DTO, the snapshot and the feedback tokens are unchanged.
 */
export const groupItems = (items: PyDict[]): PyDict[] => items.map(asGroup).sort((a, b) => pyCmp(rankKey(a), rankKey(b)));

/** One listing as a single-member group: the record's own token, tracking and display basis. */
export function asGroup(item: PyDict): PyDict {
  const group = deepCopy(item);
  const fps = conflictVersionsOf(item).map((v) => v.str("fingerprint"));
  const revision = trackingAt(item, "revision", 0n);
  let token = item.str("fingerprint") + ":" + pyStr(revision);
  if (truthy(item.at("content_conflicts"))) token += ":" + identityHash(pySorted(fps));
  if (truthy(item.at("application_token"))) token += ":applications:" + identityHash(item.get("application_token")!);
  group.set("members", [PyDict.of({
    id: item.req("id"), source: item.dict("job").req("source"), url: item.dict("job").at("url"),
    fingerprint: item.req("fingerprint"),
    observation_fingerprints: pySorted(new Set([item.str("fingerprint"), ...fps])),
    token, revision,
  })]);
  group.set("member_ids", [item.req("id")]);
  group.set("application_ids", pySorted(new Set(asList(item.at("application_ids") ?? []).map(String))));
  group.set("novelty_keys", [...novelty(item).values()].sort(pyCmp));
  group.set("content_conflicts", conflictsOf(item));
  if (truthy(group.get("content_conflicts"))) {
    const basis = group.dict("recommendation").req("basis_fingerprint");
    const chosen = conflictVersionsOf(group).find((v) => pyEq(v.req("fingerprint"), basis)) ?? null;
    if (chosen && !truthy(chosen.req("original"))) {
      group.set("job", deepCopy(chosen.req("job")));
      group.set("evaluation", deepCopy(chosen.req("evaluation")));
    }
    group.set("display_basis", PyDict.of({
      source: group.dict("job").req("source"), fingerprint: basis,
      label: chosen && !truthy(chosen.req("original")) ? "另一份通知內容" : "現有紀錄",
    }));
  }
  if (!group.has("tracking")) group.set("tracking", new PyDict());
  const feedback = trackingAt(item, "feedback", "neutral");
  group.dict("tracking").set("feedback", pyEq(feedback, "skipped") ? "skipped" : pyEq(feedback, "interested") ? "interested" : "neutral");
  if (pyEq(item.at("review_status"), "skipped")) group.set("review_status", "skipped");
  if (!pyEq(trackingAt(item, "stage", "not_applied"), "not_applied")) group.dict("tracking").set("stage", trackingOf(item).req("stage"));
  return group;
}

/** sorted key: (not is_candidate(item), -score, id) */
function rankKey(item: PyDict): PyValue[] {
  const rec = item.has("recommendation") ? item.dict("recommendation") : new PyDict();
  const score = rec.has("score") ? rec.get("score")! : item.dict("evaluation").req("score");
  return [!isCandidate(item), negate(score), item.req("id")];
}

export function negate(v: PyValue): PyValue {
  if (typeof v === "bigint") return -v;
  if (typeof v === "number") return -v;
  if (typeof v === "boolean") return v ? -1n : 0n;
  throw new PyError("TypeError", "bad operand type for unary -");
}

/** The discovery API does not expose proposal or CRM payloads. */
export function publicItem(item: PyDict): PyDict {
  const result = new PyDict();
  for (const key of ["id", "job", "evaluation", "recommendation", "review_status", "members", "member_ids", "content_conflicts", "display_basis"]) {
    if (item.has(key)) result.set(key, item.get(key)!);
  }
  result.set("job", publicJob(item.dict("job")));
  result.set("content_conflicts", conflictsOf(item).map((c) => {
    const conflict = new PyDict(asDict(c));
    conflict.set("versions", asList(conflict.req("versions")).map((v) => new PyDict(asDict(v)).update({ job: publicJob(asDict(v).dict("job")) })));
    return conflict;
  }));
  const tracking = trackingOf(item);
  result.set("tracking", new PyDict(["feedback", "stage", "revision"].map((k) => [k, tracking.at(k)])));
  result.set("candidate", isCandidate(item));
  if (truthy(item.at("application_ids"))) result.set("application_ids", item.get("application_ids")!);
  return result;
}


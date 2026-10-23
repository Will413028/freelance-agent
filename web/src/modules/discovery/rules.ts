import type { PyDateTime } from "@/platform/py/datetime";
import { identityHash } from "@/platform/py/json";
import { pyLen, pyStr, text } from "@/platform/py/unicode";
import { hostname, urlsplit, urlunsplit, userinfo } from "@/platform/py/url";
import {
  asDict, asList, cmpStr, deepCopy, isDict, isNumber, or, pyCmp, pyEq, PyDict, PyError, pySorted, truthy, TupleSet,
  type PyValue,
} from "@/platform/py/value";
import { DEFAULT_HOURS, qualify } from "./domain";
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
  if (!isDict(value) || value.size !== keys.length || !keys.every((k) => value.has(k))) throw new PyError("ValueError", "篩選設定欄位不符");
  const hours = value.get("max_weekly_hours")!, budget = value.get("min_fixed_twd")!, categories = value.get("categories")!;
  if (hours !== null && (!isNumber(hours) || pyCmp(hours, 1n) < 0 || pyCmp(hours, 168n) > 0)) throw new PyError("ValueError", "工時上限需為 1–168 小時，或不限");
  if (!isNumber(budget) || pyCmp(budget, 0n) < 0 || pyCmp(budget, 10_000_000n) > 0) throw new PyError("ValueError", "最低固定案預算不符範圍");
  if (!Array.isArray(categories) || !categories.length
      || categories.some((c) => typeof c !== "string" || !(CATEGORIES as readonly string[]).includes(c))
      || new Set(categories).size !== categories.length) {
    throw new PyError("ValueError", "請至少選擇一種專長分類");
  }
  return deepCopy(value);
}

export function evaluate(job: PyDict, settings: PyDict, now: PyDateTime): PyDict {
  const result = qualify(job, settings.req("max_weekly_hours"), now, settings.req("min_fixed_twd"));
  const categories = asList(settings.req("categories"));
  if (!categories.some((c) => pyEq(c, result.get("category")!)) && result.get("status") !== "excluded") {
    (result.get("reasons") as PyValue[]).push("不在目前選擇的專長分類");
    result.set("status", "excluded");
  }
  return result;
}

export function project(item: PyDict, settings: PyDict, now: PyDateTime): PyDict {
  const result = deepCopy(item);
  result.set("evaluation", evaluate(result.dict("job"), settings, now));
  if (result.dict("evaluation").get("status") !== "qualified" && pyEq(result.req("review_status"), "approved")) {
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

/** Keep every source row; group presentation and feedback with revision tokens. */
export function groupItems(items: PyDict[]): PyDict[] {
  const parents = items.map((_, i) => i);
  const grouped = new Map<number, number[]>(items.map((_, i) => [i, [i]]));
  const jobs = items.map((item) => item.dict("job"));

  // Conflicting known conditions remain separate cards for human inspection.
  const compatible = (left: PyDict, right: PyDict) => {
    for (const field of ["title", "company", "kind", "currency", "budget_min", "budget_max", "weekly_hours",
      "taiwan_eligible", "timezone_compatible", "listing_closed"]) {
      const a = left.at(field), b = right.at(field);
      if (a !== null && b !== null && a !== "" && b !== "" && text(a) !== text(b)) return false;
    }
    return true;
  };
  const root = (index: number) => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };

  const keys = new Map<string, number[]>();
  items.forEach((item, index) => {
    // Python iterates a set here, whose order follows the per-process PYTHONHASHSEED. When one
    // listing's URL key and content key reach two groups that are incompatible with each other,
    // the first key wins, so Python's partition can differ between processes. Sorted keys make
    // the TS partition deterministic (a known, accepted comparator difference).
    for (const key of identityKeys(jobs[index])) {
      for (const prior of keys.get(key) ?? []) {
        const left = root(index), right = root(prior);
        if (left !== right && grouped.get(left)!.every((a) => grouped.get(right)!.every((b) => compatible(jobs[a], jobs[b])))) {
          parents[left] = right;
          grouped.get(right)!.push(...grouped.get(left)!);
          grouped.delete(left);
        }
      }
      if (!keys.has(key)) keys.set(key, []);
      keys.get(key)!.push(index);
    }
  });

  const buckets = new Map<number, PyDict[]>();
  items.forEach((item, index) => {
    const r = root(index);
    if (!buckets.has(r)) buckets.set(r, []);
    buckets.get(r)!.push(item);
  });

  const result: PyDict[] = [];
  for (const members of buckets.values()) {
    const representative = members.find((item) => isCandidate(item)) ?? members[0];
    const group = deepCopy(representative);
    group.set("members", members.map((item) => {
      const fps = conflictVersionsOf(item).map((v) => v.str("fingerprint"));
      const revision = trackingAt(item, "revision", 0n);
      let token = item.str("fingerprint") + ":" + pyStr(revision);
      if (truthy(item.at("content_conflicts"))) token += ":" + identityHash(pySorted(fps));
      if (truthy(item.at("application_token"))) token += ":applications:" + identityHash(item.get("application_token")!);
      return PyDict.of({
        id: item.req("id"), source: item.dict("job").req("source"), url: item.dict("job").at("url"),
        fingerprint: item.req("fingerprint"),
        observation_fingerprints: pySorted(new Set([item.str("fingerprint"), ...fps])),
        token, revision,
      });
    }));
    group.set("member_ids", members.map((item) => item.req("id")));
    group.set("application_ids", pySorted(new Set(members.flatMap((item) => asList(item.at("application_ids") ?? []).map(String)))));
    const union = new TupleSet();
    for (const item of members) for (const pair of novelty(item).values()) union.add(pair);
    group.set("novelty_keys", [...union.values()].sort(pyCmp));
    group.set("content_conflicts", members.flatMap((item) => conflictsOf(item)));
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
    const states = members.map((item) => trackingAt(item, "feedback", "neutral"));
    const feedback = states.some((s) => pyEq(s, "skipped")) ? "skipped" : states.some((s) => pyEq(s, "interested")) ? "interested" : "neutral";
    if (!group.has("tracking")) group.set("tracking", new PyDict());
    group.dict("tracking").set("feedback", feedback);
    if (members.some((item) => pyEq(item.at("review_status"), "skipped"))) group.set("review_status", "skipped");
    const staged = members.find((item) => !pyEq(trackingAt(item, "stage", "not_applied"), "not_applied"));
    if (staged) group.dict("tracking").set("stage", trackingOf(staged).req("stage"));
    result.push(group);
  }
  return result.sort((a, b) => pyCmp(rankKey(a), rankKey(b)));
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

export function unseen(item: PyDict, seen: TupleSet): boolean {
  const knownIds = new Set([...seen.values()].map(([id]) => id));
  const members = item.has("members") ? asList(item.get("members")!).map(asDict) : [item];
  const changed = members.some((m) => knownIds.has(m.str("id")) && asList(m.has("observation_fingerprints")
    ? m.get("observation_fingerprints")! : [m.req("fingerprint")]).some((fp) => !seen.has([m.str("id"), String(fp)])));
  return changed || !novelty(item).intersects(seen);
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


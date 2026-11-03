import type { Db } from "@/db/client";
import { REGISTRY, sourceChecks } from "@/modules/collection/public";
import { asGroup, CATEGORIES, isCandidate, PUBLIC_JOB_FIELDS, readSettings, VIEWS, type View } from "@/modules/discovery/public";
import { latestDailyRun } from "@/modules/notifications/public";
import type { PyDateTime } from "@/platform/py/datetime";
import { asDict, asList, isDict, PyDict, type PyValue } from "@/platform/py/value";
import { group, listPage } from "./discovery";

// What the pages render (plan step 11): typed views with only the fields a page shows. Pages output
// rendered HTML only, so these views are the whitelist; nothing else of a record leaves the server.

/** A value as the page reads it: JSON-like, integers as numbers (every integer shown is small). */
export type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

export function plain(value: PyValue): Plain {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof PyDict) return Object.fromEntries([...value].map(([k, v]) => [k, plain(v)]));
  return value;
}

/** A job's public fields (PUBLIC_JOB_FIELDS) as the page reads them. */
export type JobFields = Record<string, Plain>;

export type Feedback = "neutral" | "interested" | "skipped";

export type ContentVersion = { fingerprint: string; original: boolean; status: string; job: JobFields };

export type JobView = {
  id: string;
  /** What the page sends back with its feedback: the listing's token when the page was rendered. */
  token: string;
  source: string;
  sourceName: string;
  /** The record's own listing URL (the member's), whichever content version the card displays. */
  memberUrl: Plain;
  job: JobFields;
  status: string;
  category: string;
  reasons: string[];
  questions: string[];
  score: number;
  freshness: string;
  completeness: number;
  rankReasons: string[];
  /** Whether the listing is a candidate; null on a detail page, which has no ranking. */
  candidate: boolean | null;
  feedback: Feedback;
  skipped: boolean;
  conflicts: { changedFields: string[]; versions: ContentVersion[] }[];
  displayBasis: { sourceName: string; label: string; fingerprint: string } | null;
};

const sourceName = (source: string) => REGISTRY[source]?.name ?? source;
const strings = (value: PyValue | undefined) => asList(value ?? []).filter((v): v is string => typeof v === "string");
const jobFields = (job: PyDict): JobFields =>
  Object.fromEntries([...job].filter(([k]) => PUBLIC_JOB_FIELDS.has(k)).map(([k, v]) => [k, plain(v)]));

/** A listing's group (asGroup) as the page shows it. */
export function jobView(g: PyDict, candidate: boolean | null): JobView {
  const job = g.dict("job"), evaluation = g.dict("evaluation"), rec = g.dict("recommendation");
  const member = asDict(asList(g.req("members"))[0]);
  const tracking = g.has("tracking") ? g.dict("tracking") : new PyDict();
  const feedback = tracking.at("feedback");
  const basis = g.has("display_basis") && isDict(g.get("display_basis")!) ? g.dict("display_basis") : null;
  return {
    id: g.str("id"),
    token: member.str("token"),
    source: job.str("source"),
    sourceName: sourceName(job.str("source")),
    memberUrl: plain(member.at("url") ?? null),
    job: jobFields(job),
    status: evaluation.str("status"),
    category: String(evaluation.at("category") ?? ""),
    reasons: strings(evaluation.at("reasons")),
    questions: strings(evaluation.at("questions")),
    score: Number(rec.req("score")),
    freshness: rec.str("freshness"),
    completeness: Number(rec.req("completeness")),
    rankReasons: strings(rec.at("reasons")),
    candidate,
    feedback: feedback === "interested" || feedback === "skipped" ? feedback : "neutral",
    skipped: feedback === "skipped" || g.at("review_status") === "skipped",
    conflicts: asList(g.at("content_conflicts") ?? []).map((c) => {
      const conflict = asDict(c);
      return {
        changedFields: strings(conflict.at("changed_fields")),
        versions: asList(conflict.req("versions")).map((v) => {
          const version = asDict(v);
          return { fingerprint: version.str("fingerprint"), original: version.at("original") === true, status: version.dict("evaluation").str("status"), job: jobFields(version.dict("job")) };
        }),
      };
    }),
    displayBasis: basis ? { sourceName: sourceName(basis.str("source")), label: basis.str("label"), fingerprint: basis.str("fingerprint") } : null,
  };
}

/** Listings per page (plan step 11); the page reads one more to know whether a next page exists. */
export const PAGE_SIZE = 50;

export type ListView = { view: View; page: number; jobs: JobView[]; hasNext: boolean };

/** The `view` and `page` query parameters, falling back to the first page of the candidates. */
export function listQuery(params: { view?: string | string[]; page?: string | string[] }): { view: View; page: number } {
  const view = typeof params.view === "string" && (VIEWS as readonly string[]).includes(params.view) ? params.view as View : "candidates";
  const page = typeof params.page === "string" && /^[1-9][0-9]{0,5}$/.test(params.page) ? Number(params.page) : 1;
  return { view, page };
}

export async function listJobs(db: Db, now: PyDateTime, view: View, page: number): Promise<ListView> {
  const items = await listPage(db, now, { offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE + 1 }, view);
  const jobs = items.slice(0, PAGE_SIZE).map((item) => jobView(asGroup(item), isCandidate(item)));
  return { view, page, jobs, hasNext: items.length > PAGE_SIZE };
}

export async function jobDetail(db: Db, now: PyDateTime, id: string): Promise<JobView> {
  return jobView(await group(db, id, now), null);
}

export type SettingsView = {
  revision: number;
  maxWeeklyHours: number | null;
  minFixedTwd: number;
  categories: string[];
  allCategories: readonly string[];
};

export async function settingsPage(db: Db): Promise<SettingsView> {
  const s = await readSettings(db);
  const hours = s.settings.at("max_weekly_hours");
  return {
    revision: Number(s.revision),
    maxWeeklyHours: hours === null || hours === undefined ? null : Number(hours),
    minFixedTwd: Number(s.settings.req("min_fixed_twd")),
    categories: strings(s.settings.at("categories")),
    allCategories: CATEGORIES,
  };
}

export type SourceRow = { source: string; name: string; status: string; checkedAt: string | null; daily: Record<string, Plain> | null };
export type SourcesView = {
  lastRun: { localDate: string; status: string; startedAt: string; finishedAt: string | null; reason: string | null } | null;
  sources: SourceRow[];
};

export async function sourcesPage(db: Db): Promise<SourcesView> {
  const [checks, run] = await Promise.all([sourceChecks(db), latestDailyRun(db)]);
  const result = run && isDict(run.result) ? run.result : null;
  const details = result && result.has("source_details") && isDict(result.get("source_details")!) ? result.dict("source_details") : null;
  const reason = result?.at("source_reason") ?? result?.at("reason") ?? null;
  return {
    lastRun: run ? { localDate: run.localDate, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, reason: typeof reason === "string" ? reason : null } : null,
    sources: [...checks].map(([source, v]) => {
      const check = asDict(v), daily = details?.at(source);
      return {
        source, name: sourceName(source), status: String(check.at("status")),
        checkedAt: typeof check.at("checked_at") === "string" ? check.str("checked_at") : null,
        daily: daily !== undefined && isDict(daily) ? plain(daily) as Record<string, Plain> : null,
      };
    }),
  };
}

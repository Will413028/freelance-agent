import type { Db } from "@/db/client";
import type { PgDb } from "@/db/pg/client";
import { CATEGORIES } from "@/db/pg/schema";
import { REGISTRY, sourceChecks } from "@/modules/collection/public";
import { storageSignals, type StorageSignal } from "@/ops/storage-triggers";
import { evaluate, PAGE_SIZE, rankedPage, readSettings, recommend, VIEWS, type Content, type FeedbackState, type Settings, type View } from "@/modules/evaluation/public";
import { listingOfRow, readShown, type ListingRow, type Shown, type VersionRow } from "@/modules/listings/public";
import { latestDailyRun } from "@/modules/notifications/public";
import { feedbackToken, saveSettings, setFeedback } from "@/modules/review/public";
import { NotFound } from "@/platform/errors";
import { asDict, isDict, PyDict, type PyValue } from "@/platform/py/value";

// What the pages render (plan step 3c): typed views with only the fields a page shows. Pages output
// rendered HTML only, so these views are the whitelist; nothing else of a record leaves the server.
// The list, detail and settings pages read Postgres; /sources still reads D1 until plan step 6.

export { PAGE_SIZE };

/** A value as the page reads it: JSON-like, integers as numbers (every integer shown is small). */
export type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

export function plain(value: PyValue): Plain {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof PyDict) return Object.fromEntries([...value].map(([k, v]) => [k, plain(v)]));
  return value;
}

/** A content's shown fields, keyed as the page names them. */
export type JobFields = {
  title: string; company: string | null; description: string | null; kind: string | null; currency: string | null;
  budget_min: number | null; budget_max: number | null; weekly_hours: number | null; location: string | null;
  taiwan_eligible: boolean | null; timezone_compatible: boolean | null; deadline: string | null; listing_closed: boolean | null; url: string | null;
};

/** The fields a version comparison checks, in the order the page lists them. */
export const COMPARED_FIELDS = ["title", "company", "description", "kind", "currency", "budget_min", "budget_max", "weekly_hours", "location",
  "taiwan_eligible", "timezone_compatible", "deadline", "listing_closed", "url"] as const satisfies readonly (keyof JobFields)[];

export type Feedback = "neutral" | "interested" | "skipped";

export type ContentVersion = { fingerprint: string; original: boolean; status: string; job: JobFields };

export type JobView = {
  id: number;
  /** What the page sends back with its feedback: the listing's feedback revision when the page was rendered. */
  token: string;
  source: string;
  sourceName: string;
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
  /** A mail listing's differing contents, the listing row's own first; null when there is one content. */
  conflict: { changedFields: string[]; versions: ContentVersion[] } | null;
  /** The version the score comes from when it is not the shown row's content (its fingerprint), else null. */
  rankedOn: string | null;
};

const sourceName = (source: string) => REGISTRY[source]?.name ?? source;

const jobFields = (r: ListingRow | VersionRow): JobFields => ({
  title: r.title, company: r.company, description: r.description, kind: r.kind, currency: r.currency, budget_min: r.budgetMin,
  budget_max: r.budgetMax, weekly_hours: r.weeklyHours, location: r.location, taiwan_eligible: r.taiwanEligible,
  timezone_compatible: r.timezoneCompatible, deadline: r.deadlineText, listing_closed: r.listingClosed, url: r.url,
});

const contentOf = (r: ListingRow | VersionRow): Content => ({ fingerprint: r.fingerprint, listing: listingOfRow(r) });

/** One listing as the page shows it: the row's content and evaluation, the recommendation over all its contents. */
export function jobView({ row, versions, feedback }: Shown, s: Settings, now: Date, candidate: boolean | null): JobView {
  const content = contentOf(row), evaluation = evaluate(content.listing, s, now);
  const rec = recommend(content, versions.map(contentOf), feedback.state, s, now);
  let conflict: JobView["conflict"] = null;
  if (versions.length) {
    const shown = versions.map((v) => ({ v, job: jobFields(v) }));
    conflict = {
      changedFields: COMPARED_FIELDS.filter((f) => new Set(shown.map(({ job }) => JSON.stringify(job[f]))).size > 1),
      // Oldest first (readShown), so the row's own content, the first one seen, leads.
      versions: shown.map(({ v, job }) => ({ fingerprint: v.fingerprint, original: v.fingerprint === row.fingerprint, status: evaluate(listingOfRow(v), s, now).status, job })),
    };
  }
  return {
    id: row.id, token: feedbackToken(feedback.revision), source: row.source, sourceName: sourceName(row.source), job: jobFields(row),
    status: evaluation.status, category: evaluation.category, reasons: evaluation.reasons, questions: evaluation.questions,
    score: rec.score, freshness: rec.freshness, completeness: rec.completeness, rankReasons: rec.reasons,
    candidate, feedback: feedback.state, skipped: feedback.state === "skipped", conflict,
    rankedOn: rec.basis === row.fingerprint ? null : rec.basis,
  };
}

export type ListView = { view: View; page: number; jobs: JobView[]; hasNext: boolean };

/** The `view` and `page` query parameters, falling back to the first page of the candidates. */
export function listQuery(params: { view?: string | string[]; page?: string | string[] }): { view: View; page: number } {
  const view = typeof params.view === "string" && (VIEWS as readonly string[]).includes(params.view) ? params.view as View : "candidates";
  const page = typeof params.page === "string" && /^[1-9][0-9]{0,5}$/.test(params.page) ? Number(params.page) : 1;
  return { view, page };
}

/** One page (from 1) of a view in rank order. */
export async function listJobs(db: PgDb, now: Date, view: View, page: number): Promise<ListView> {
  const { settings } = await readSettings(db);
  const { total, items } = await rankedPage(db, settings, now, view, page - 1);
  const shown = await readShown(db, items.map((i) => i.id));
  // A listing deleted between the two reads is left out of this page.
  const jobs = items.flatMap((i) => { const s = shown.get(i.id); return s ? [jobView(s, settings, now, i.candidate)] : []; });
  return { view, page, jobs, hasNext: page * PAGE_SIZE < total };
}

/** A listing id as a URL carries it: a positive integer in the id column's range, otherwise not found. */
function idOf(text: string): number {
  const id = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : 0;
  if (!id || id > 2 ** 31 - 1) throw new NotFound(text);
  return id;
}

export async function jobDetail(db: PgDb, now: Date, text: string): Promise<JobView> {
  const id = idOf(text);
  const [{ settings }, shown] = await Promise.all([readSettings(db), readShown(db, [id])]);
  const s = shown.get(id);
  if (!s) throw new NotFound(text);
  return jobView(s, settings, now, null);
}

/** The page writes (plan step 3c): routes call these, never the module. */
export const writeFeedback = async (db: PgDb, id: string, token: string, state: FeedbackState, now: Date) => setFeedback(db, idOf(id), token, state, now);
export const writeSettings = (db: PgDb, revision: number, s: Settings) => saveSettings(db, revision, s);

export type SettingsView = {
  revision: number;
  maxWeeklyHours: number | null;
  minFixedTwd: number;
  categories: readonly string[];
  allCategories: readonly string[];
};

export async function settingsPage(db: PgDb): Promise<SettingsView> {
  const { revision, settings } = await readSettings(db);
  return { revision, maxWeeklyHours: settings.maxWeeklyHours, minFixedTwd: settings.minFixedTwd, categories: settings.categories, allCategories: CATEGORIES };
}

export type SourceRow = { source: string; name: string; status: string; checkedAt: string | null; daily: Record<string, Plain> | null };
/** How many days of runs, ending with the latest one, the sources page checks for storage signals. */
const SIGNAL_DAYS = 7;
const daysBefore = (localDate: string, days: number) => new Date(Date.parse(`${localDate}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

export type SourcesView = {
  /** Signals that reopen a deferred storage decision (D18, D20, D21, the projection read), over the runs checked. */
  signals: { runs: number; reopened: StorageSignal[] };
  lastRun: { localDate: string; status: string; startedAt: string; finishedAt: string | null; reason: string | null } | null;
  sources: SourceRow[];
};

export async function sourcesPage(db: Db): Promise<SourcesView> {
  const [checks, run] = await Promise.all([sourceChecks(db), latestDailyRun(db)]);
  const result = run && isDict(run.result) ? run.result : null;
  const details = result && result.has("source_details") && isDict(result.get("source_details")!) ? result.dict("source_details") : null;
  const reason = result?.at("source_reason") ?? result?.at("reason") ?? null;
  // Nothing else runs this check since the cutover (plan step 14); "totals" only qualifies a run's numbers.
  const checked = run ? await storageSignals(db, daysBefore(run.localDate, SIGNAL_DAYS - 1)) : { runs: 0, signals: [] };
  return {
    signals: { runs: checked.runs, reopened: checked.signals.filter((s) => s.decision !== "totals") },
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

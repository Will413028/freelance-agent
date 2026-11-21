import type { PgDb } from "@/db/pg/client";
import { CATEGORIES, OPPORTUNITY_TYPES, type OpportunityType } from "@/db/pg/schema";
import { DEFAULT_SETTINGS, evaluate, expired, PAGE_SIZE, rankedPage, readSettings, recommend, VIEWS, type Content, type FeedbackState, type Settings, type View } from "@/modules/evaluation/public";
import { listingOfRow, readShown, type ListingRow, type Shown, type VersionRow } from "@/modules/listings/public";
import { lastSourceOkAt, latestRuns } from "@/modules/runs/public";
import { FINAL_REASONS, isReasonOf, markRejected, rejectedGroups, SOURCES, sourceLabel, type MailDisposition } from "@/modules/sources/public";
import { feedbackToken, saveSettings, setFeedback } from "@/modules/review/public";
import { InvalidAction, NotFound } from "@/platform/errors";

// What the pages render (plan step 3c): typed views with only the fields a page shows. Pages output
// rendered HTML only, so these views are the whitelist; nothing else of a record leaves the server.
// Every page reads Postgres (/sources since plan step 6).

export { PAGE_SIZE };

/** A value as the page reads it: JSON-like, integers as numbers (every integer shown is small). */
export type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

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
    id: row.id, token: feedbackToken(feedback.revision), source: row.source, sourceName: sourceLabel(row.source), job: jobFields(row),
    status: evaluation.status, category: evaluation.category, reasons: evaluation.reasons, questions: evaluation.questions,
    score: rec.score, freshness: rec.freshness, completeness: rec.completeness, rankReasons: rec.reasons,
    candidate, feedback: feedback.state, skipped: feedback.state === "skipped", conflict,
    rankedOn: rec.basis === row.fingerprint ? null : rec.basis,
  };
}

export type ListView = { view: View; page: number; jobs: JobView[]; hasNext: boolean };

/** A contest's shown fields (opportunity types plan D5). Unknown is null: the page says so, it never fills one in. */
export type ContestFields = {
  title: string; organiser: string | null; url: string | null; location: string | null;
  /** The submission deadline as the source gave it (a date, an instant, or its unusable text), and whether it is usable. */
  deadline: string | null; deadlineUsable: boolean; registration_deadline: string | null;
  prize_text: string | null; currency: string | null; prize_max: number | null;
  online: boolean | null; invite_only: boolean | null; hackathon: boolean | null;
};

export type ContestView = {
  id: number;
  token: string;
  source: string;
  sourceName: string;
  contest: ContestFields;
  /** Open, past its submission deadline, or closed by its source. */
  state: "open" | "expired" | "closed";
  /** Whether the contest is a candidate; null on a detail page, which has no ranking. */
  candidate: boolean | null;
  feedback: Feedback;
  skipped: boolean;
};

export type ContestListView = { view: View; page: number; contests: ContestView[]; hasNext: boolean };

/** One contest as the page shows it (plan D2, D3: no score, an invite-only contest is shown and marked). */
export function contestView({ row, feedback }: Shown, now: Date, candidate: boolean | null): ContestView {
  return {
    id: row.id, token: feedbackToken(feedback.revision), source: row.source, sourceName: sourceLabel(row.source),
    contest: {
      title: row.title, organiser: row.company, url: row.url, location: row.location,
      deadline: row.deadlineText, deadlineUsable: row.deadlineAt !== null, registration_deadline: row.registrationDeadline,
      prize_text: row.prizeText, currency: row.currency, prize_max: row.budgetMax,
      online: row.online, invite_only: row.inviteOnly, hackathon: row.hackathon,
    },
    state: row.listingClosed === true ? "closed" : expired(row, now) ? "expired" : "open",
    candidate, feedback: feedback.state, skipped: feedback.state === "skipped",
  };
}

/** Hours after a source was last read successfully by the daily run before the pages say the schedule may have stopped (plan step 6b). */
export const STALE_RUN_HOURS = 26;

/** Null while the last successful source read is recent enough; otherwise when it finished (null: never). */
export type StaleRun = { lastSuccessAt: string | null } | null;

/** A dead-man switch shown on the pages only (plan D22: no mail): has the daily run gone quiet? */
export async function runStale(db: PgDb, now: Date): Promise<StaleRun> {
  const at = await lastSourceOkAt(db);
  if (at && now.getTime() - at.getTime() <= STALE_RUN_HOURS * 3_600_000) return null;
  return { lastSuccessAt: at?.toISOString() ?? null };
}

/** The `type`, `view` and `page` query parameters, falling back to the first page of the job candidates. */
export function listQuery(params: { type?: string | string[]; view?: string | string[]; page?: string | string[] }): { type: OpportunityType; view: View; page: number } {
  const type = typeof params.type === "string" && (OPPORTUNITY_TYPES as readonly string[]).includes(params.type) ? params.type as OpportunityType : "job";
  const view = typeof params.view === "string" && (VIEWS as readonly string[]).includes(params.view) ? params.view as View : "candidates";
  const page = typeof params.page === "string" && /^[1-9][0-9]{0,5}$/.test(params.page) ? Number(params.page) : 1;
  return { type, view, page };
}

/** One page (from 1) of a view in rank order. */
export async function listJobs(db: PgDb, now: Date, view: View, page: number): Promise<ListView> {
  const { settings } = await readSettings(db);
  const { total, items } = await rankedPage(db, "job", settings, now, view, page - 1);
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

/** One page (from 1) of a view of the contests, by submission deadline. Contests have no settings (plan D6). */
export async function listContests(db: PgDb, now: Date, view: View, page: number): Promise<ContestListView> {
  const { total, items } = await rankedPage(db, "contest", DEFAULT_SETTINGS, now, view, page - 1);
  const shown = await readShown(db, items.map((i) => i.id));
  const contests = items.flatMap((i) => { const s = shown.get(i.id); return s ? [contestView(s, now, i.candidate)] : []; });
  return { view, page, contests, hasNext: page * PAGE_SIZE < total };
}

export type DetailView = { type: "job"; job: JobView } | { type: "contest"; contest: ContestView };

/**
 * One listing by its id, shown by the rules of its type. A listing of a type this image does not know (a
 * newer image wrote it, then a rollback) is not found: no rule here applies to it.
 */
export async function listingDetail(db: PgDb, now: Date, text: string): Promise<DetailView> {
  const id = idOf(text);
  const s = (await readShown(db, [id])).get(id);
  const type = OPPORTUNITY_TYPES.find((t) => t === s?.row.opportunityType);
  if (!s || !type) throw new NotFound(text);
  switch (type) {
    case "job": return { type, job: jobView(s, (await readSettings(db)).settings, now, null) };
    case "contest": return { type, contest: contestView(s, now, null) };
  }
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

/** The list page's query budget (plan step 5a2-3: ≤ 250 ms at the measured row count); /sources flags a daily run whose timing exceeds it. */
export const LIST_BUDGET_MS = 250;

/** One catalog source on /sources: its latest run_sources row, or null when no run has read it yet. */
export type SourceRow = {
  source: string; name: string; disabled: string | null;
  latest: { localDate: string; status: string; reason: string | null; counts: Record<string, Plain>; finishedAt: string | null } | null;
};

export type SourcesView = {
  stale: StaleRun;
  lastRun: { localDate: string; status: string; reason: string | null; startedAt: string; finishedAt: string | null; pruned: number | null; listMs: number | null; listSlow: boolean } | null;
  sources: SourceRow[];
  /** Rejected mail by source and reason (the dead-letter view): open, and waiting for a re-read. */
  rejectedMail: { source: string; name: string; reason: string; open: number; retry: number; canRetry: boolean; oldestDays: number }[];
};

/** Source health and the latest daily run of the new system (plan step 6): reads runs and run_sources. */
export async function sourcesPage(db: PgDb, now: Date): Promise<SourcesView> {
  const [{ run, sources }, stale, rejected] = await Promise.all([latestRuns(db), runStale(db, now), rejectedGroups(db)]);
  const bySource = new Map(sources.map((r) => [r.source, r]));
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const listMs = run ? num(run.counts.listMs) : null;
  return {
    stale,
    lastRun: run ? {
      localDate: run.localDate, status: run.status, reason: run.reason, startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null, pruned: num(run.counts.pruned), listMs, listSlow: listMs !== null && listMs > LIST_BUDGET_MS,
    } : null,
    sources: [...SOURCES].sort((a, b) => a.order - b.order).map((s) => {
      const r = bySource.get(s.name);
      return {
        source: s.name, name: sourceLabel(s.name), disabled: s.disabled,
        latest: r ? { localDate: r.localDate, status: r.status, reason: r.reason, counts: r.counts as Record<string, Plain>, finishedAt: r.finishedAt?.toISOString() ?? null } : null,
      };
    }),
    rejectedMail: rejected.map(({ oldest, ...g }) => ({ ...g, name: sourceLabel(g.source), canRetry: !(FINAL_REASONS as readonly string[]).includes(g.reason), oldestDays: Math.floor((now.getTime() - oldest.getTime()) / 86_400_000) })),
  };
}

/** Marks a mail source's rejected messages of one reason for a re-read or as dismissed (the /sources writes). */
export async function writeMailDisposition(db: PgDb, source: string, reason: string, disposition: MailDisposition): Promise<number> {
  if (!SOURCES.some((s) => s.name === source && s.kind === "mail") || !isReasonOf(source, reason)) throw new InvalidAction("來源或原因代碼不符");
  if (disposition === "retry" && FINAL_REASONS.includes(reason)) throw new InvalidAction("這類被拒的信無法重讀");
  return markRejected(db, source, reason, disposition);
}

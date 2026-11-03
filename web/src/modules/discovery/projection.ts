import { asc, desc, eq, sql, type SQLWrapper } from "drizzle-orm";
import { read, type Db } from "@/db/client";
import { discoveryItems, discoverySettings, discoveryVersions, manualApplicationOpportunities, manualApplications, opportunities, mailContentVersions, opportunityTracking } from "@/db/schema";
import type { Writes } from "@/db/unit";
import { PyDateTime } from "@/platform/py/datetime";
import { num, type PyDict, type PyValue } from "@/platform/py/value";
import type { Deadline, Unexpired } from "./domain";
import { confirmedCount, publishedAt, RECENT_US, WEEK_US } from "./ranking";
import { evaluateUnexpired, outsideCategories } from "./rules";
import type { Settings } from "./settings";

// The discovery read model (D16, D18 P1, plan step 10e1). Every row is derived from one stored row
// (an opportunity record or a mail content version) and the settings, by the same functions evaluate
// and recommendation use, and is written by the unit that writes its source row. SQL ranks and
// filters on it; whatever depends on the clock is computed at read from deadline_at and published_at.

const US_PER_DAY = 86_400_000_000n;
const ORD_1970 = 719_163;
/** 0001-01-01T00:00Z and 10000-01-01T00:00Z in microseconds since the epoch. */
const MIN_US = BigInt(1 - ORD_1970) * US_PER_DAY;
const END_US = BigInt(3_652_060 - ORD_1970) * US_PER_DAY;
export const BEFORE_YEAR_1 = "0000-00-00T00:00:00.000000Z";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/**
 * A UTC instant as text that orders like the instant: before year 1 is BEFORE_YEAR_1, from year 10000
 * on is null (a deadline that never comes, a publication that is never in the past).
 */
export function utcText(us: bigint): string | null {
  if (us < MIN_US) return BEFORE_YEAR_1;
  if (us >= END_US) return null;
  const t = PyDateTime.fromUtcMicros(us);
  return `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}.${pad(t.microsecond, 6)}Z`;
}

/** The instant a deadline expires the listing in UTC: a date-only deadline at the start of the next UTC day. */
export function deadlineText(deadline: Deadline): string | null {
  if (deadline === null) return null;
  return utcText("instant" in deadline ? deadline.instant : BigInt(deadline.day + 1 - ORD_1970) * US_PER_DAY);
}

type Columns = { deadlineAt: string | null; publishedAt: string | null; settingsRevision: number; excluded: 0 | 1; baseTenths: number };
export type ItemRow = Columns & { opportunityId: string; fingerprint: string; reviewStatus: string | null };
export type VersionRow = Columns & { opportunityId: string; fingerprint: string };

/** The status evaluate gives while the deadline has not passed: the deadline can only add an exclusion. */
const excludedBeforeDeadline = (u: Unexpired, settings: PyDict) => u.result.get("status") === "excluded" || outsideCategories(u.result, settings);

/** The columns one listing (a record's job or a content version's job) projects to under these settings. */
function columns(job: PyDict, s: Settings): Columns {
  const u = evaluateUnexpired(job, s.settings);
  const published = publishedAt(job);
  return {
    deadlineAt: deadlineText(u.deadline),
    publishedAt: published === null ? null : utcText(published.utcMicros()),
    settingsRevision: Number(s.revision),
    excluded: excludedBeforeDeadline(u, s.settings) ? 1 : 0,
    // recommendation's score before tracking and freshness, × 10: category × 0.7 and 2.5 per confirmed condition.
    baseTenths: num(u.result.req("score")) * 7 + 25 * confirmedCount(job, u.result),
  };
}

export function itemRow(item: PyDict, s: Settings): ItemRow {
  const review = item.at("review_status");
  return {
    opportunityId: item.str("id"), fingerprint: item.str("fingerprint"), reviewStatus: typeof review === "string" ? review : null,
    ...columns(item.dict("job"), s),
  };
}

export const versionRow = (opportunityId: string, fingerprint: string, job: PyDict, s: Settings): VersionRow =>
  ({ opportunityId, fingerprint, ...columns(job, s) });

const ITEM_SET = [discoveryItems.fingerprint, discoveryItems.reviewStatus, discoveryItems.deadlineAt, discoveryItems.publishedAt,
  discoveryItems.settingsRevision, discoveryItems.excluded, discoveryItems.baseTenths];
const VERSION_SET = [discoveryVersions.deadlineAt, discoveryVersions.publishedAt, discoveryVersions.settingsRevision, discoveryVersions.excluded, discoveryVersions.baseTenths];

/** The record's projection row, written with the record (Records.save, Records.insert). */
export function putItem(writes: Writes, item: PyDict, s: Settings) {
  const row = itemRow(item, s);
  writes.put(discoveryItems, { kind: "update", target: discoveryItems.opportunityId, set: ITEM_SET }, row.opportunityId, row, row.opportunityId);
}

/** A content version's projection row, written with the version (ContentVersions.add). */
export function putVersion(writes: Writes, opportunityId: string, fingerprint: string, job: PyDict, s: Settings) {
  const row = versionRow(opportunityId, fingerprint, job, s);
  writes.put(discoveryVersions, { kind: "update", target: [discoveryVersions.opportunityId, discoveryVersions.fingerprint], set: VERSION_SET },
    `${opportunityId}\0${fingerprint}`, row, opportunityId);
}

/** Bytes of JSON per bulk statement's one parameter, well inside D1's 100 KB statement and 2 MB value limits. */
const BULK_BYTES = 90_000;

function chunksOf<T>(items: readonly T[], encode: (item: T) => string): string[] {
  const out: string[] = [];
  let current: string[] = [], bytes = 2;
  for (const item of items) {
    const text = encode(item), size = Buffer.byteLength(text) + 1;
    if (current.length && bytes + size > BULK_BYTES) {
      out.push(`[${current.join(",")}]`);
      current = [];
      bytes = 2;
    }
    current.push(text);
    bytes += size;
  }
  if (current.length) out.push(`[${current.join(",")}]`);
  return out;
}

/**
 * A settings change (replaceSettings): the settings-dependent columns of every row, recomputed and
 * written in the settings unit as a few UPDATE … FROM json_each statements (one JSON parameter each),
 * so the whole table fits one request where a row-per-parameter upsert would need hundreds of
 * statements (plan step 4e2b handoff (2)). Rows the unit read but did not change are written too:
 * every row must carry the new revision, or the read refuses the table.
 */
export function putSettingsColumns(db: Db, writes: Writes, records: readonly PyDict[], versions: readonly { opportunityId: string; fingerprint: string; job: PyDict }[], s: Settings) {
  const revision = Number(s.revision);
  const items = records.map((item) => [item.str("id"), columns(item.dict("job"), s)] as const);
  for (const chunk of chunksOf(items, ([id, c]) => JSON.stringify([id, c.excluded, c.baseTenths]))) {
    writes.statement(db.run(sql`update discovery_items set settings_revision = ${revision}, excluded = json_extract(j.value, '$[1]'),
      base_tenths = json_extract(j.value, '$[2]') from json_each(${chunk}) as j where discovery_items.opportunity_id = json_extract(j.value, '$[0]')`), Buffer.byteLength(chunk));
  }
  const rows = versions.map((v) => [v.opportunityId, v.fingerprint, columns(v.job, s)] as const);
  for (const chunk of chunksOf(rows, ([id, fp, c]) => JSON.stringify([id, fp, c.excluded, c.baseTenths]))) {
    writes.statement(db.run(sql`update discovery_versions set settings_revision = ${revision}, excluded = json_extract(j.value, '$[2]'),
      base_tenths = json_extract(j.value, '$[3]') from json_each(${chunk}) as j
      where discovery_versions.opportunity_id = json_extract(j.value, '$[0]') and discovery_versions.fingerprint = json_extract(j.value, '$[1]')`), Buffer.byteLength(chunk));
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────────────────────────

/** The stored settings revision; 0 before the first settings change, as settingsRead. */
const currentRevision = sql`coalesce((select ${discoverySettings.revision} from ${discoverySettings} where ${discoverySettings.id} = 1), 0)`;

/** Whether the projection matches the tables it derives from: every row there, all under the current settings. */
export type ProjectionState = { items: number; records: number; versions: number; contentVersions: number; stale: number };

export const projectionStateRead = (db: Db) => read(db.select({
  items: sql<number>`(select count(*) from ${discoveryItems})`,
  records: sql<number>`(select count(*) from ${opportunities})`,
  versions: sql<number>`(select count(*) from ${discoveryVersions})`,
  contentVersions: sql<number>`(select count(*) from ${mailContentVersions})`,
  stale: sql<number>`(select count(*) from ${discoveryItems} where ${discoveryItems.settingsRevision} <> ${currentRevision})
    + (select count(*) from ${discoveryVersions} where ${discoveryVersions.settingsRevision} <> ${currentRevision})`,
}).from(sql`(select 1)`), ([row]): ProjectionState => row);

export class ProjectionMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionMismatch";
  }
}

export function checkState(state: ProjectionState) {
  if (state.items !== state.records || state.versions !== state.contentVersions || state.stale !== 0) {
    throw new ProjectionMismatch(`discovery projection out of date: ${JSON.stringify(state)}`);
  }
}

/** One ranked listing as SQL ordered it: is it a candidate, and its recommendation score in tenths. */
export type Ranked = { id: string; candidate: boolean; scoreTenths: number };

/**
 * The ranked page: recommendation's score and is_candidate over the projection, at `now`, ordered as
 * rankItems orders (candidates first, higher score, then id). `now` must be UTC: a date-only deadline
 * expires at the next day of now's own calendar, which the projection stores for UTC.
 */
export function rankedRead(db: Db, now: PyDateTime, page: { offset: number; limit: number }) {
  if (now.offset !== 0n) throw new Error("the discovery projection is read at a UTC now");
  // The instants are SQL literals, not parameters: each is used many times and D1 binds at most 100.
  const literal = (us: bigint) => {
    const text = utcText(us);
    if (text === null || !/^[0-9:.TZ-]+$/.test(text)) throw new Error(`no SQL literal for ${us}`);
    return sql.raw(`'${text}'`);
  };
  const at = literal(now.utcMicros()), recent = literal(now.utcMicros() - RECENT_US), week = literal(now.utcMicros() - WEEK_US);
  const i = discoveryItems, v = discoveryVersions, t = opportunityTracking;
  const fresh = (p: SQLWrapper) =>
    sql`(case when ${p} <= ${at} and ${p} >= ${recent} then 100 when ${p} < ${recent} and ${p} >= ${week} then 60 else 0 end)`;
  const possible = sql`(${i.excluded} = 0 and (${i.deadlineAt} is null or ${i.deadlineAt} > ${at}))`;
  // The best score among the content versions that differ from the record and are still possible (recommendation's options).
  const versionBest = sql`(select max(${v.baseTenths} + ${fresh(v.publishedAt)}) from ${v} where ${v.opportunityId} = ${i.opportunityId}
    and ${v.fingerprint} <> ${i.fingerprint} and ${v.excluded} = 0 and (${v.deadlineAt} is null or ${v.deadlineAt} > ${at}))`;
  const own = sql`(${i.baseTenths} + ${fresh(i.publishedAt)})`;
  const best = sql`(case when ${possible} then max(${own}, coalesce(${versionBest}, ${own})) else coalesce(${versionBest}, ${own}) end)`;
  const feedback = sql`json_extract(${t.state}, '$.feedback')`;
  const score = sql<number>`min(1000, ${best} + (case when ${feedback} = 'interested' then 100 else 0 end))`;
  const stage = sql`(case when ${t.state} is null or json_type(${t.state}, '$.stage') is null then 'not_applied' else json_extract(${t.state}, '$.stage') end)`;
  const candidate = sql<number>`((${possible} or ${versionBest} is not null)
    and not exists (select 1 from ${manualApplicationOpportunities} join ${manualApplications} on ${manualApplications.id} = ${manualApplicationOpportunities.applicationId}
      where ${manualApplicationOpportunities.opportunityId} = ${i.opportunityId} and ${manualApplications.deletedAt} is null)
    and coalesce(${i.reviewStatus} not in ('skipped', 'sent', 'delivered'), 1)
    and coalesce(${feedback} <> 'skipped', 1)
    and ${stage} is 'not_applied')`;
  return read(db.select({ id: i.opportunityId, candidate, score }).from(i).leftJoin(t, eq(t.opportunityId, i.opportunityId))
    .orderBy(desc(candidate), desc(score), asc(i.opportunityId)).limit(page.limit).offset(page.offset),
  (rows): Ranked[] => rows.map((r) => ({ id: r.id, candidate: r.candidate === 1, scoreTenths: r.score })));
}

/** recommendation's score in tenths, as SQL computes it: 100 is the cap, every other score has one decimal. */
export const scoreTenths = (score: PyValue) => (typeof score === "bigint" ? Number(score) * 10 : Math.round(num(score) * 10));

/** Checks a page item recomputed in TS against what SQL ranked it by. */
export function checkRanked(item: PyDict, candidate: boolean, ranked: Ranked) {
  const tenths = scoreTenths(item.dict("recommendation").req("score"));
  if (candidate !== ranked.candidate || tenths !== ranked.scoreTenths) {
    throw new ProjectionMismatch(`discovery projection disagrees for ${ranked.id}: SQL ${JSON.stringify(ranked)}, TS candidate ${candidate} score ${tenths}`);
  }
}


/** Source, raw title and publication instant of every listing (the D18 trigger measurement, plan step 10e2). */
export const titlesRead = (db: Db) => read(db.select({
  id: opportunities.id, source: opportunities.source, title: sql<unknown>`json_extract(${opportunities.item}, '$.job.title')`, publishedAt: discoveryItems.publishedAt,
}).from(opportunities).innerJoin(discoveryItems, eq(discoveryItems.opportunityId, opportunities.id)), (rows) => rows);

import { insertChunks, readAll, type Db, type ReadValues } from "@/db/client";
import type { D1Statement } from "@/db/d1/client";
import { discoveryItems, discoveryVersions } from "@/db/schema";
import { DAILY_WRITE, UI_WAIT_MS, withLease, writeUnit, type WritePolicy } from "@/db/unit";
import { applicationProjectionsFor, applicationProjectionsRead, type ApplicationProjection } from "@/modules/applications/public";
import { contentVersionsFor, contentVersionsRead, type ContentVersionRow } from "@/modules/collection/public";
import { allRecordsRead, Records, recordsRead } from "@/modules/legacy/public";
import { emptyTracking, track as trackIn, trackingRead, Trackings, trackingStatesRead, trackReads, type TrackingChange } from "@/modules/preferences/public";
import { Conflict, InvalidAction, uiBusy } from "@/platform/errors";
import type { PyDateTime } from "@/platform/py/datetime";
import { encode, loadsDict } from "@/platform/py/json";
import { asDict, asList, cmpStr, isDict, pyEq, PyDict, PyError, type PyValue } from "@/platform/py/value";
import {
  checkRanked, checkState, defaults, evaluate, groupItems, isCandidate, itemRow, ProjectionMismatch, projectionStateRead, rankedRead, preferences, project, PUBLIC_JOB_FIELDS, putSettings, putSettingsColumns, rankOrder, recommendation, settingsRead, versionRow,
  type Settings,
} from "@/modules/discovery/public";

// Port of discovery/service.py: discovery queries and atomic group feedback shared by all entry
// points. It composes legacy records, preferences, collection and applications, so it lives above
// the modules (the Python facade wires them by injection in bootstrap/store.py).

const OBSERVATION_ONLY = new Set(["received_at", "receipt_id", "evidence_ref", "raw_evidence_ref"]);

/** Page requests wait 5 s for the writer lease and answer 409 when they give up (D20-B). */
const PAGE_WRITE: WritePolicy = { waitMs: UI_WAIT_MS, busy: uiBusy };

/** What list_in reads, to run in one request alone or with a caller's other reads (readAll). */
export const listReads = (db: Db) =>
  [allRecordsRead(db), settingsRead(db), contentVersionsRead(db), trackingStatesRead(db), applicationProjectionsRead(db)] as const;

export type ListData = ReadValues<ReturnType<typeof listReads>>;

/** list_in over rows read together by listReads. */
export const assembleList = ([rows, { settings }, contentRows, states, applications]: ListData, now: PyDateTime): PyDict[] =>
  rankOrder(assembleItems(rows, settings, contentRows, states, applications, now));

/** Records as list_in builds its items: evaluated at `now`, with tracking, applications and differing content versions. */
function assembleItems(rows: readonly PyDict[], settings: PyDict, contentRows: readonly ContentVersionRow[], states: Map<string, PyDict>,
  applications: Map<string, ApplicationProjection>, now: PyDateTime): PyDict[] {
  const items = rows.map((row) => project(row, settings, now));
  const versions = new Map<string, { fingerprint: string; job: string }[]>();
  for (const row of contentRows) {
    if (!versions.has(row.opportunityId)) versions.set(row.opportunityId, []);
    versions.get(row.opportunityId)!.push(row);
  }
  for (const item of items) {
    const id = item.str("id");
    item.set("tracking", states.get(id) ?? emptyTracking());
    const application = applications.get(id) ?? { ids: [], token: [] };
    item.set("application_ids", application.ids);
    item.set("application_token", application.token);
    const observed = versions.get(id) ?? [];
    if (observed.some((row) => row.fingerprint !== item.str("fingerprint"))) {
      const choices = [PyDict.of({ fingerprint: item.req("fingerprint"), job: item.req("job"), evaluation: item.req("evaluation"), original: true })];
      for (const row of observed.filter((r) => r.fingerprint !== item.str("fingerprint"))) {
        choices.push(PyDict.of({ fingerprint: row.fingerprint, job: loadsDict(row.job), evaluation: evaluate(loadsDict(row.job), settings, now), original: false }));
      }
      const fields = [...new Set(choices.flatMap((c) => [...c.dict("job").keys()]))]
        .filter((f) => !OBSERVATION_ONLY.has(f) && PUBLIC_JOB_FIELDS.has(f)).sort(cmpStr);
      const changed = fields.filter((f) => new Set(choices.map((c) => encode(c.dict("job").at(f)))).size > 1);
      const job = item.dict("job");
      item.set("content_conflicts", [PyDict.of({ source: job.req("source"), external_id: job.req("external_id"), versions: choices, changed_fields: changed })]);
    }
    item.set("recommendation", recommendation(item, now));
  }
  return items;
}

export const list = async (db: Db, now: PyDateTime) => assembleList(await readAll(db, listReads(db)), now);

export async function group(db: Db, key: string, now: PyDateTime): Promise<PyDict> {
  const found = groupItems(await list(db, now)).find((g) => asList(g.req("member_ids")).includes(key));
  if (!found) throw new PyError("KeyError", key);
  return found;
}

/** Versions the caller saw: {member id: token} for every member of the group. */
export const memberVersions = (g: PyDict) => new PyDict(asList(g.req("members")).map((m) => [asDict(m).str("id"), asDict(m).req("token")]));

/**
 * Group feedback as one unit: the whole list is read with the writer lease (until plan step 10e2
 * reads the group's projection instead), every member's token is compared with what the caller saw,
 * and every member's tracking is written in one batch.
 */
export async function feedback(db: Db, key: string, versions: PyValue, value: PyValue, now: PyDateTime) {
  if (!["neutral", "interested", "skipped"].some((s) => pyEq(value, s))) throw new InvalidAction("不支援的職缺狀態");
  return writeUnit(db, PAGE_WRITE, listReads(db), (data, writes) => {
    const [rows, s, , states] = data;
    const settings = s.settings;
    const items = assembleList(data, now);
    const g = groupItems(items).find((x) => asList(x.req("member_ids")).includes(key));
    if (!g) throw new PyError("KeyError", key);
    if (!isDict(versions) || [...versions.values()].some((v) => typeof v !== "string") || !pyEq(versions, memberVersions(g))) {
      throw new Conflict("職缺或收藏狀態已更新，請重新載入");
    }
    const unit = { records: Records.over(rows, writes, s), trackings: new Trackings(states, writes), settings };
    const byId = new Map(items.map((item) => [item.str("id"), item]));
    for (const m of asList(g.req("members")).map(asDict)) {
      const state = byId.get(m.str("id"))!.dict("tracking");
      trackIn(unit, m.str("id"), m.req("revision"), {
        feedback: value, note: state.has("note") ? state.get("note")! : "", evidence: state.has("evidence") ? state.get("evidence")! : "",
      }, now);
    }
    return PyDict.of({ status: "saved" });
  });
}

/** Record tracking through preferences, then assemble the recommendation, which belongs to discovery. */
export async function track(db: Db, key: string, revision: PyValue, change: TrackingChange, now: PyDateTime): Promise<PyDict> {
  const item = await writeUnit(db, PAGE_WRITE, trackReads(db, [key]), ([s, records, states], writes) =>
    trackIn({ records: new Records(records, writes, s), trackings: new Trackings(states, writes), settings: s.settings }, key, revision, change, now));
  item.set("recommendation", recommendation(item, now));
  return item;
}

/**
 * A settings change as one page unit: the new revision and the settings columns of every projection
 * row, recomputed from all records and content versions read with the writer lease (plan step 10e1).
 */
export async function replaceSettings(db: Db, revision: PyValue, value: PyValue): Promise<Settings> {
  const settings = preferences(value);
  return writeUnit(db, PAGE_WRITE, [settingsRead(db), allRecordsRead(db), contentVersionsRead(db)], ([current, records, versions], writes) => {
    const next = putSettings(writes, current, revision, settings);
    putSettingsColumns(db, writes, records, versions.map((v) => ({ opportunityId: v.opportunityId, fingerprint: v.fingerprint, job: loadsDict(v.job) })), next);
    return next;
  });
}

/** What the projection is rebuilt from: stored record envelopes, content versions and the settings row, as text. */
export type ProjectionSource = {
  items: readonly string[];
  versions: readonly { opportunityId: string; fingerprint: string; job: string }[];
  settings: { revision: number; settings: string } | null;
};

/**
 * Every projection row, from scratch: after an import (into tables just recreated empty) and in the
 * replay, under the caller's lease (`send`). The same row functions as the incremental writes, so a
 * rebuild equals what maintenance produced (tests/projection.test.ts). Returns the rows written.
 */
export async function rebuildProjection(db: Db, source: ProjectionSource, send: (statements: D1Statement[]) => Promise<unknown>): Promise<number> {
  const s: Settings = source.settings ? { revision: BigInt(source.settings.revision), settings: loadsDict(source.settings.settings) } : { revision: 0n, settings: preferences(defaults()) };
  const items = source.items.map((text) => itemRow(loadsDict(text), s));
  const versions = source.versions.map((v) => versionRow(v.opportunityId, v.fingerprint, loadsDict(v.job), s));
  const statements = [
    ...insertChunks(items, Object.keys(items[0] ?? {}).length || 1).map((chunk) => db.insert(discoveryItems).values(chunk).toSQL()),
    ...insertChunks(versions, Object.keys(versions[0] ?? {}).length || 1).map((chunk) => db.insert(discoveryVersions).values(chunk).toSQL()),
  ];
  await send(statements.map((q) => ({ sql: q.sql, params: q.params as D1Statement["params"] })));
  return items.length + versions.length;
}

/**
 * One page of the discovery list from the projection (D18 P1, plan step 10e1): SQL ranks every
 * listing at `now` and returns the page's ids; only the page's own rows are read back and assembled
 * as list_in does, and each item's candidacy and score must equal what SQL ranked it by. A write
 * between the two requests can make them disagree, so the read is tried twice before it fails.
 * Plan step 10e2 moves the list, groups, feedback and digest onto this read.
 */
export async function listPage(db: Db, now: PyDateTime, page: { offset: number; limit: number }): Promise<PyDict[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await pageOnce(db, now, page);
    } catch (e) {
      if (!(e instanceof ProjectionMismatch) || attempt >= 1) throw e;
    }
  }
}

async function pageOnce(db: Db, now: PyDateTime, page: { offset: number; limit: number }) {
  const [state, s, ranked] = await readAll(db, [projectionStateRead(db), settingsRead(db), rankedRead(db, now, page)]);
  checkState(state);
  const ids = ranked.map((r) => r.id);
  const [records, contentRows, states, applications, again] = await readAll(db,
    [recordsRead(db, ids), contentVersionsFor(db, ids), trackingRead(db, ids), applicationProjectionsFor(db, ids), settingsRead(db)]);
  if (again.revision !== s.revision) throw new ProjectionMismatch("discovery settings changed between the ranking and the page read");
  const rows = ids.map((id) => records.get(id) ?? (() => { throw new ProjectionMismatch(`record ${id} disappeared between the ranking and the page read`); })());
  const items = assembleItems(rows, s.settings, contentRows, states, applications, now);
  items.forEach((item, i) => checkRanked(item, isCandidate(item), ranked[i]));
  return items;
}

/**
 * Rebuilds the projection in place on a live database (plan step 10e1): after the migration that
 * creates its tables, and whenever its derivation changes. Holds the writer lease from the read to
 * the last write, so no unit writes a record in between; reads D1's own rows, never a copy.
 */
export async function rebuildProjectionInPlace(db: Db, waitMs = DAILY_WRITE.waitMs): Promise<number> {
  return withLease(db, waitMs, async (send) => {
    const [items, versions, settings] = await send([
      { sql: "select item from opportunities order by id", params: [] },
      { sql: "select opportunity_id, fingerprint, job from mail_content_versions order by opportunity_id, fingerprint", params: [] },
      { sql: "select revision, settings from discovery_settings where id = 1", params: [] },
    ]);
    await send([{ sql: "delete from discovery_versions", params: [] }, { sql: "delete from discovery_items", params: [] }]);
    const [row] = settings.rows;
    return rebuildProjection(db, {
      items: items.rows.map((r) => String(r[0])),
      versions: versions.rows.map((r) => ({ opportunityId: String(r[0]), fingerprint: String(r[1]), job: String(r[2]) })),
      settings: row ? { revision: Number(row[0]), settings: String(row[1]) } : null,
    }, send);
  });
}

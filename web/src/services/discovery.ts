import { readAll, type Db, type ReadValues } from "@/db/client";
import { UI_WAIT_MS, writeUnit, type WritePolicy } from "@/db/unit";
import { applicationProjectionsRead } from "@/modules/applications/public";
import { contentVersionsRead } from "@/modules/collection/public";
import { allRecordsRead, Records } from "@/modules/legacy/public";
import { emptyTracking, track as trackIn, Trackings, trackingStatesRead, trackReads, type TrackingChange } from "@/modules/preferences/public";
import { Conflict, InvalidAction, uiBusy } from "@/platform/errors";
import type { PyDateTime } from "@/platform/py/datetime";
import { encode, loadsDict } from "@/platform/py/json";
import { asDict, asList, cmpStr, isDict, pyEq, PyDict, PyError, type PyValue } from "@/platform/py/value";
import { evaluate, groupItems, project, PUBLIC_JOB_FIELDS, rankItems, recommendation, settingsRead } from "@/modules/discovery/public";

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
export function assembleList([rows, { settings }, contentRows, states, applications]: ListData, now: PyDateTime): PyDict[] {
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
  }
  return rankItems(items, now);
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
    const [rows, { settings }, , states] = data;
    const items = assembleList(data, now);
    const g = groupItems(items).find((x) => asList(x.req("member_ids")).includes(key));
    if (!g) throw new PyError("KeyError", key);
    if (!isDict(versions) || [...versions.values()].some((v) => typeof v !== "string") || !pyEq(versions, memberVersions(g))) {
      throw new Conflict("職缺或收藏狀態已更新，請重新載入");
    }
    const unit = { records: Records.over(rows, writes), trackings: new Trackings(states, writes), settings };
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
  const item = await writeUnit(db, PAGE_WRITE, trackReads(db, [key]), ([{ settings }, records, states], writes) =>
    trackIn({ records: new Records(records, writes), trackings: new Trackings(states, writes), settings }, key, revision, change, now));
  item.set("recommendation", recommendation(item, now));
  return item;
}

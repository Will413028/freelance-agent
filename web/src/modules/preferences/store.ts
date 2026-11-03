import { inList, read, type Db } from "@/db/client";
import { opportunityTracking, trackingEvents } from "@/db/schema";
import type { Writes } from "@/db/unit";
import { settingsRead } from "@/modules/discovery/public";
import { feedbackChanged, Records, recordsRead } from "@/modules/legacy/public";
import type { PyDateTime } from "@/platform/py/datetime";
import { encode, loadsDict } from "@/platform/py/json";
import { deepCopy, PyError, type PyDict } from "@/platform/py/value";
import { emptyTracking, updateTracking, type TrackingChange } from "./domain";

// Port of preferences/store.py: preferences and feedback, preserving the historical tracking ledger.

export const trackingStatesRead = (db: Db) =>
  read(db.select().from(opportunityTracking), (rows) => new Map(rows.map((r) => [r.opportunityId, loadsDict(r.state)])));

const trackingRead = (db: Db, keys: readonly string[]) =>
  read(db.select().from(opportunityTracking).where(inList(opportunityTracking.opportunityId, keys)), (rows) => new Map(rows.map((r) => [r.opportunityId, loadsDict(r.state)])));

/**
 * A unit's view of tracking states: those it read, with the revisions it records. A record that has
 * none yet starts from emptyTracking(). Every recorded revision also appends a tracking_events row,
 * whose unique (opportunity, revision) refuses a second writer of the same revision.
 */
export class Trackings {
  private readonly stored: Set<string>;

  constructor(private readonly states: Map<string, PyDict>, private readonly writes: Writes) {
    this.stored = new Set(states.keys());
  }

  get(key: string): PyDict {
    const state = this.states.get(key);
    return state ? deepCopy(state) : emptyTracking();
  }

  record(key: string, state: PyDict, createdAt: string) {
    const encoded = encode(state);
    this.states.set(key, deepCopy(state));
    const on = this.stored.has(key) ? { kind: "update" as const, target: opportunityTracking.opportunityId, set: [opportunityTracking.state] } : { kind: "insert" as const };
    this.writes.put(opportunityTracking, on, key, { opportunityId: key, state: encoded }, key);
    this.writes.put(trackingEvents, { kind: "insert" }, `${key}\0${state.req("revision")}`,
      { opportunityId: key, revision: Number(state.req("revision")), state: encoded, createdAt }, key);
  }
}

/** What a tracking change decides on, for a unit's read request: the records, their tracking and the settings. */
export const trackReads = (db: Db, keys: readonly string[]) => [settingsRead(db), recordsRead(db, keys), trackingRead(db, keys)] as const;

export type TrackUnit = { records: Records; trackings: Trackings; settings: PyDict };

/** Records one tracking revision in the caller's unit and returns the item with it. */
export function track(unit: TrackUnit, key: string, revision: unknown, change: TrackingChange, now: PyDateTime): PyDict {
  const item = unit.records.get(key);
  if (item === null) throw new PyError("KeyError", key);
  const state = updateTracking(unit.trackings.get(key), revision as never, now, change);
  unit.trackings.record(key, state, now.isoformat());
  const changed = feedbackChanged(unit.records, unit.settings, item, change.feedback ?? null, now);
  changed.set("tracking", state);
  return changed;
}

import { eq } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { opportunityTracking, trackingEvents } from "@/db/schema";
import { feedbackChanged, getRecord } from "@/modules/legacy/public";
import type { PyDateTime } from "@/platform/py/datetime";
import { encode, loadsDict } from "@/platform/py/json";
import { PyError, type PyDict } from "@/platform/py/value";
import { emptyTracking, updateTracking, type TrackingChange } from "./domain";

// Port of preferences/store.py: preferences and feedback, preserving the historical tracking ledger.

export async function trackingStates(tx: Executor): Promise<Map<string, PyDict>> {
  const rows = await tx.select().from(opportunityTracking);
  return new Map(rows.map((r) => [r.opportunityId, loadsDict(r.state)]));
}

export async function trackingState(tx: Executor, key: string): Promise<PyDict> {
  const [row] = await tx.select({ state: opportunityTracking.state }).from(opportunityTracking).where(eq(opportunityTracking.opportunityId, key));
  return row ? loadsDict(row.state) : emptyTracking();
}

/** Records one tracking revision inside the caller's write transaction and returns the item with it. */
export async function track(tx: Executor, key: string, revision: unknown, change: TrackingChange, now: PyDateTime): Promise<PyDict> {
  const item = await getRecord(tx, key);
  if (item === null) throw new PyError("KeyError", key);
  const current = await trackingState(tx, key);
  const state = updateTracking(current, revision as never, now, change);
  const encoded = encode(state);
  await tx.insert(opportunityTracking).values({ opportunityId: key, state: encoded })
    .onConflictDoUpdate({ target: opportunityTracking.opportunityId, set: { state: encoded } });
  await tx.insert(trackingEvents).values({ opportunityId: key, revision: Number(state.req("revision")), state: encoded, createdAt: now.isoformat() });
  const changed = await feedbackChanged(tx, item, change.feedback ?? null, now);
  changed.set("tracking", state);
  return changed;
}

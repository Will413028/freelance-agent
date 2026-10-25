import type { Db } from "@/db/client";
import { PyDict, type PyValue } from "@/platform/py/value";
import { setSourceHealth } from "./ingest";
import type { SourceRunner } from "./registry";

/** A connector's outcome as collection/service.py reads it; only ok and waiting count as success. */
export type SourceOutcome = "ok" | "partial" | "waiting" | "failed";

/**
 * One source's entry in daily_runs.result.source_details: the connector's result dict, carried as a
 * workflow step's return value. The plan keeps step data to ids, counts and statuses, so values are
 * limited to identifier strings (status, reason, scope), non-negative integers, booleans, null and
 * one level of identifier → count (error_stages); anything else is refused, never truncated.
 */
export type SourceDetail = Record<string, DetailValue>;
export type DetailValue = string | number | boolean | null | Record<string, number>;

const IDENT = /^[a-z0-9_]{1,80}$/;
// A letter first: integer-like keys would lose their insertion order in a JS object.
const KEY = /^[a-z][a-z0-9_]{0,79}$/;
const count = (v: PyValue) => typeof v === "bigint" && v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER);

function detailOf(result: unknown): SourceDetail | null {
  if (!(result instanceof PyDict) || typeof result.at("status") !== "string") return null;
  const detail: SourceDetail = {};
  for (const [key, v] of result) {
    if (!KEY.test(key)) return null;
    if (v === null || typeof v === "boolean") detail[key] = v;
    else if (typeof v === "string" && IDENT.test(v)) detail[key] = v;
    else if (count(v)) detail[key] = Number(v);
    else if (v instanceof PyDict && [...v].every(([k, n]) => KEY.test(k) && count(n))) {
      detail[key] = Object.fromEntries([...v].map(([k, n]) => [k, Number(n)]));
    } else return null;
  }
  return detail;
}

/** The detail back as the dict Python stored (integers as ints), in the connector's key order. */
export function detailDict(detail: SourceDetail): PyDict {
  const py = (v: DetailValue): PyValue => typeof v === "number" ? BigInt(v)
    : v !== null && typeof v === "object" ? new PyDict(Object.entries(v).map(([k, n]) => [k, BigInt(n)])) : v;
  return new PyDict(Object.entries(detail).map(([k, v]) => [k, py(v)]));
}

export const succeeded = (detail: SourceDetail) => detail.status === "ok" || detail.status === "waiting";

// Mirrors the Python connectors: a sync is marked failed before it starts, so an interrupted run
// never leaves a stale ok behind. A connector that finishes sets its own final health. Where a TS
// connector throws, its Python sync returns {'status': 'failed', 'reason': <fixed per module>}.
export async function runSource(db: Db, source: string, runner: SourceRunner, failure = "source_unavailable"): Promise<SourceDetail> {
  await setSourceHealth(db, source, "failed");
  let result: unknown;
  try {
    result = await runner(db);
  } catch {
    return { status: "failed", reason: failure };
  }
  return detailOf(result) ?? { status: "failed", reason: "invalid_source_result" };
}

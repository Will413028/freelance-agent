import type { Db } from "@/db/client";
import { PyDict } from "@/platform/py/value";
import { setSourceHealth } from "./ingest";
import type { SourceRunner } from "./registry";

/** A connector's outcome as collection/service.py reads it; only ok and waiting count as success. */
export type SourceOutcome = "ok" | "partial" | "waiting" | "failed";

// Mirrors the Python connectors: a sync is marked failed before it starts, so an interrupted run
// never leaves a stale ok behind. A connector that finishes sets its own final health.
export async function runSource(db: Db, source: string, runner: SourceRunner): Promise<SourceOutcome> {
  await setSourceHealth(db, source, "failed");
  let result: unknown;
  try {
    result = await runner(db);
  } catch {
    return "failed";
  }
  // Connectors return Python's result dict; a partial batch (rejected listings) is not a success.
  const status = result instanceof PyDict ? result.at("status") : "ok";
  return status === "partial" || status === "waiting" || status === "failed" ? status : "ok";
}

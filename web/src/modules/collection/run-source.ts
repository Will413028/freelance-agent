import type { Db } from "@/db/client";
import { setSourceHealth } from "./ingest";
import type { SourceRunner } from "./registry";

// Mirrors the Python connectors: a sync is marked failed before it starts, so an interrupted run
// never leaves a stale ok behind. A connector that finishes sets its own final health.
export async function runSource(db: Db, source: string, runner: SourceRunner): Promise<"ok" | "failed"> {
  await setSourceHealth(db, source, "failed");
  try {
    await runner(db);
  } catch {
    return "failed";
  }
  return "ok";
}

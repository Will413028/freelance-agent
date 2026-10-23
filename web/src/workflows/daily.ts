import { getDb } from "@/db/client";
import { SOURCES } from "@/modules/collection/registry";
import { runSource } from "@/modules/collection/run-source";

// Step inputs and outputs carry only source ids and statuses (plan invariant).
export async function dailyWorkflow(sources: string[]) {
  "use workflow";
  const results = await Promise.allSettled(sources.map((source) => syncSource(source)));
  return results.map((r, i) => ({ source: sources[i], status: r.status === "fulfilled" ? r.value : "failed" }));
}

async function syncSource(source: string) {
  "use step";
  const runner = SOURCES[source];
  if (!runner) return "failed" as const;
  return runSource(getDb(), source, runner);
}
syncSource.maxRetries = 0;

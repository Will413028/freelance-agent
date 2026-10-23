import type { Db } from "@/db/client";
import { setSourceHealth } from "./source-health";

export type SourceRunner = () => Promise<void>;

// Mirrors the Python connectors: a sync is marked failed before it starts, so an
// interrupted run never leaves a stale ok behind.
export async function runSource(db: Db, source: string, runner: SourceRunner): Promise<"ok" | "failed"> {
  await setSourceHealth(db, source, "failed");
  try {
    await runner();
  } catch {
    return "failed";
  }
  await setSourceHealth(db, source, "ok");
  return "ok";
}

import type { Db } from "@/db/client";
import { ingestSource, isSource } from "@/modules/collection/public";
import type { PyDateTime } from "@/platform/py/datetime";
import { PyDict, PyError, type PyValue } from "@/platform/py/value";
import { query } from "./db";

// Python store operations the golden scenarios replay, which the product no longer has on its own.

/** Collection.ingest: one listing as its own intake unit. */
export async function ingestOne(db: Db, job: PyValue, receiptId: PyValue, now: PyDateTime): Promise<PyDict> {
  const source = job instanceof PyDict ? job.at("source") : null;
  return (await ingestSource(db, source, now, [[job, receiptId]], () => true, null))[0];
}

/** Collection.existing_source_ids. */
export async function existingSourceIds(source: PyValue): Promise<Set<string>> {
  if (!isSource(source)) throw new PyError("ValueError", "unknown source");
  return new Set((await query<{ id: string }>("select external_id id from opportunities where source = ?", [source])).map((r) => r.id));
}

import { clientOf, getDb, type Db } from "@/db/client";
import { PyError } from "@/platform/py/value";

// One log line per page request with its D1 usage (plan step 11): the D13 page measurement, and the
// read retries that the daily run's counters never see. Vercel keeps runtime logs about an hour.

/** Runs `load` on a fresh client and logs what it cost, whether it succeeded or threw. */
export async function withPageDb<T>(route: string, load: (db: Db) => Promise<T>, db: Db = getDb()): Promise<T> {
  const started = Date.now();
  let outcome = "ok";
  try {
    return await load(db);
  } catch (e) {
    // Not constructor.name: the production build minifies class names.
    outcome = e instanceof PyError ? e.pyType : e instanceof Error ? e.name : "error";
    throw e;
  } finally {
    const c = clientOf(db).counters;
    console.info(`page usage ${route} outcome=${outcome} ms=${Date.now() - started} d1_requests=${c.requests} rows_read=${c.rowsRead} rows_written=${c.rowsWritten} read_retries=${c.readRetries} lease_wait_ms=${Math.round(c.leaseWaitMs)}`);
  }
}

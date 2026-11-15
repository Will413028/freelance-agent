import { PyError } from "@/platform/py/value";

// One log line per page request (plan step 3c): route, outcome and time.

/** One log line per Postgres page request (plan step 3c): route, outcome and time, for the 3d page measurement. */
export async function withPageLog<T>(route: string, load: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let outcome = "ok";
  try {
    return await load();
  } catch (e) {
    outcome = e instanceof PyError ? e.pyType : e instanceof Error ? e.name : "error";
    throw e;
  } finally {
    console.info(`page ${route} outcome=${outcome} ms=${Date.now() - started}`);
  }
}

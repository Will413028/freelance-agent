import { fromisoformat } from "@/platform/py/datetime";
import { PyError, truthy, type PyDict } from "@/platform/py/value";

// Port of collection/observation.py: ordering of normalized notifications outside versioned mail intake.

/** Compare receipt times only for normalized notifications with known times. */
export function olderNotification(incoming: PyDict, current: PyDict): boolean {
  if (!truthy(incoming.at("receipt_id")) || !truthy(current.at("receipt_id"))) return false;
  try {
    const parse = (job: PyDict) => {
      const v = job.req("received_at");
      if (typeof v !== "string") throw new PyError("AttributeError", "no replace");
      return fromisoformat(v.replaceAll("Z", "+00:00"));
    };
    const next = parse(incoming), old = parse(current);
    return next.aware && old.aware && next.utcMicros() < old.utcMicros();
  } catch (e) {
    if (e instanceof PyError && ["KeyError", "AttributeError", "TypeError", "ValueError"].includes(e.pyType)) return false;
    throw e;
  }
}

// The errors a page write or page read maps to a status (app/_lib/writes.ts, app/jobs/[id]/page.tsx).
// Each names itself with a string literal, which the page log (app/_lib/page-log.ts) records as the
// outcome; a class name could be renamed when the server bundle is minified.

/** Stale token or revision, or data changed under the write: a 409. */
export class Conflict extends Error {
  override name = "Conflict";
}

/** A form field outside what the page offers: a 400. */
export class InvalidAction extends Error {
  override name = "InvalidAction";
}

/** Settings a person entered that validSettings() refuses: a 400. */
export class InvalidSettings extends Error {
  override name = "InvalidSettings";
}

/** A listing that does not exist: a 404. */
export class NotFound extends Error {
  override name = "NotFound";
}

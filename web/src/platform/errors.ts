// The errors a page write or page read maps to a status (app/_lib/writes.ts, app/jobs/[id]/page.tsx).
// Each sets `name` to its class name, which the page log (app/_lib/page-log.ts) records as the outcome.

abstract class PageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Stale token or revision, or data changed under the write: a 409. */
export class Conflict extends PageError {}

/** A form field outside what the page offers: a 400. */
export class InvalidAction extends PageError {}

/** Settings a person entered that validSettings() refuses: a 400. */
export class InvalidSettings extends PageError {}

/** A listing that does not exist: a 404. */
export class NotFound extends PageError {}

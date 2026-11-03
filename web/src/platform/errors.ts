import { PyError } from "./py/value";

// platform/errors.py: both are ValueError subclasses in Python; pyType carries the exact name so
// ported callers and tests can tell them apart.
export class Conflict extends PyError {
  constructor(message: string) {
    super("Conflict", message);
  }
}

export class InvalidAction extends PyError {
  constructor(message: string) {
    super("InvalidAction", message);
  }
}

/** Settings a person entered that preferences() refuses: a ValueError to Python-shaped callers (golden), a 400 to a page (plan step 11). */
export class InvalidSettings extends PyError {
  constructor(message: string) {
    super("ValueError", message);
  }
}

/** A record that does not exist: a KeyError to Python-shaped callers (golden), a 404 to a page (plan step 11). */
export class NotFound extends PyError {
  constructor(key: string) {
    super("KeyError", key);
  }
}

/**
 * What a page request answers when its write unit gave up on the writer lease (D20-B): 409 either
 * way; "busy" when the daily run held it past the wait, "reload" when the data kept changing.
 */
export const uiBusy = (reason: "lease_wait" | "lease_lost") => new Conflict(reason === "lease_wait" ? "系統忙碌，請稍後再試" : "資料已更新，請重新載入");

// The slice of Python's exception hierarchy the ports catch by base class.
const PARENT: Record<string, string> = {
  Conflict: "ValueError", InvalidAction: "ValueError", UnicodeError: "ValueError",
  UnicodeEncodeError: "UnicodeError", UnicodeDecodeError: "UnicodeError", OverflowError: "ArithmeticError", ParseError: "SyntaxError",
  JSONDecodeError: "ValueError", KeyError: "LookupError", TimeoutError: "OSError", URLError: "OSError", HTTPError: "URLError",
  AccessBlocked: "ValueError",
};

/** isinstance(e, (types...)) for a PyError. */
export function pyIsInstance(e: unknown, ...types: string[]): boolean {
  if (!(e instanceof PyError)) return false;
  for (let t: string | undefined = e.pyType; t; t = PARENT[t]) if (types.includes(t)) return true;
  return false;
}

export const isValueError = (e: unknown) => pyIsInstance(e, "ValueError");

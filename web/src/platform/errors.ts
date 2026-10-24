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

// The slice of Python's exception hierarchy the ports catch by base class.
const PARENT: Record<string, string> = {
  Conflict: "ValueError", InvalidAction: "ValueError", UnicodeError: "ValueError",
  UnicodeEncodeError: "UnicodeError", UnicodeDecodeError: "UnicodeError", OverflowError: "ArithmeticError", ParseError: "SyntaxError",
};

/** isinstance(e, (types...)) for a PyError. */
export function pyIsInstance(e: unknown, ...types: string[]): boolean {
  if (!(e instanceof PyError)) return false;
  for (let t: string | undefined = e.pyType; t; t = PARENT[t]) if (types.includes(t)) return true;
  return false;
}

export const isValueError = (e: unknown) => pyIsInstance(e, "ValueError");

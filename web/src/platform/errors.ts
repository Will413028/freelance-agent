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

const VALUE_ERRORS = new Set(["ValueError", "Conflict", "InvalidAction"]);
export const isValueError = (e: unknown) => e instanceof PyError && VALUE_ERRORS.has(e.pyType);

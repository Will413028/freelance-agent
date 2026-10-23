// Python value model for data the Python writer stored. JSON.parse would lose what the stored
// fingerprints depend on (spike 1c): int vs float (1 vs 1.0), ints above 2**53, and the insertion
// order of integer-like keys. So: int = bigint, float = number, dict = PyDict (an insertion-ordered Map).

export type PyValue = null | boolean | bigint | number | string | PyValue[] | PyDict;

export class PyDict extends Map<string, PyValue> {
  static of(entries: Record<string, PyValue>): PyDict {
    return new PyDict(Object.entries(entries));
  }
  /** dict.get(key) */
  at(key: string): PyValue {
    return this.has(key) ? (this.get(key) as PyValue) : null;
  }
  /** dict.update(...): existing keys keep their position, new keys go last. */
  update(entries: Record<string, PyValue>): this {
    for (const [k, v] of Object.entries(entries)) this.set(k, v);
    return this;
  }
  /** dict[key], raising KeyError when absent. */
  req(key: string): PyValue {
    if (!this.has(key)) throw new PyError("KeyError", key);
    return this.get(key) as PyValue;
  }
  dict(key: string): PyDict {
    return asDict(this.req(key));
  }
  str(key: string): string {
    const v = this.req(key);
    if (typeof v !== "string") throw new PyError("TypeError", `${key} is not a str`);
    return v;
  }
}

/** A Python exception that the ported code must raise or catch exactly where Python does. */
export class PyError extends Error {
  constructor(readonly pyType: string, message: string = pyType) {
    super(message);
  }
}

export const isDict = (v: PyValue | undefined): v is PyDict => v instanceof PyDict;
export const isList = (v: PyValue | undefined): v is PyValue[] => Array.isArray(v);
export const isInt = (v: PyValue | undefined): v is bigint => typeof v === "bigint";
export const isFloat = (v: PyValue | undefined): v is number => typeof v === "number";

export function asDict(v: PyValue | undefined): PyDict {
  if (!isDict(v)) throw new PyError("AttributeError", "not a dict");
  return v;
}
export function asList(v: PyValue | undefined): PyValue[] {
  if (!isList(v)) throw new PyError("TypeError", "not a list");
  return v;
}

/** discovery.domain.number: int or float, not bool, finite. */
export function isNumber(v: PyValue | undefined): v is bigint | number {
  return typeof v === "bigint" || (typeof v === "number" && Number.isFinite(v));
}

/** Numeric value for comparisons and float arithmetic (bool counts as int, as in Python). */
export function num(v: PyValue): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new PyError("TypeError", "not a number");
}

export function truthy(v: PyValue | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
  return v.size > 0;
}

/** Python `or`: the first truthy operand, else the last one. */
export function or(...values: PyValue[]): PyValue {
  for (const v of values.slice(0, -1)) if (truthy(v)) return v;
  return values[values.length - 1];
}

const numeric = (v: PyValue): v is boolean | bigint | number =>
  typeof v === "boolean" || typeof v === "bigint" || typeof v === "number";

/** Python ==, including True == 1 == 1.0 and order-insensitive dicts. */
export function pyEq(a: PyValue, b: PyValue): boolean {
  if (numeric(a) && numeric(b)) {
    if (typeof a === "bigint" && typeof b === "bigint") return a === b;
    const x = typeof a === "bigint" ? a : num(a), y = typeof b === "bigint" ? b : num(b);
    // bigint vs number compares exactly in JS (no precision loss), like Python int vs float.
    return x == y;
  }
  if (a === null || b === null) return a === b;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  if (isDict(a) && isDict(b)) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !pyEq(v, b.get(k) as PyValue)) return false;
    return true;
  }
  return false;
}

/** Code-point order, which is Python's str order (JS `<` compares UTF-16 units). */
export function cmpStr(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; ) {
    const x = a.codePointAt(i)!, y = b.codePointAt(i)!;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/** Python `<` ordering for the values the ported code sorts: numbers, strs, bools and sequences of them. */
export function pyCmp(a: PyValue, b: PyValue): number {
  if (numeric(a) && numeric(b)) {
    const x = typeof a === "bigint" ? a : num(a), y = typeof b === "bigint" ? b : num(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string") return cmpStr(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = pyCmp(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  throw new PyError("TypeError", "'<' not supported between these types");
}

/** sorted(values): stable, Python ordering. */
export const pySorted = <T extends PyValue>(values: Iterable<T>): T[] => [...values].sort(pyCmp);

export function deepCopy<T extends PyValue>(v: T): T {
  const x: PyValue = v;
  if (Array.isArray(x)) return x.map(deepCopy) as T;
  if (x instanceof PyDict) return new PyDict([...x.entries()].map(([k, y]) => [k, deepCopy(y)])) as T;
  return v;
}

/** Plain JS → PyValue for literals written in TS (integers in `number` become int only via bigint). */
export function py(v: unknown): PyValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean" || typeof v === "bigint" || typeof v === "number" || typeof v === "string") return v;
  if (v instanceof PyDict) return v;
  if (Array.isArray(v)) return v.map(py);
  if (typeof v === "object") return new PyDict(Object.entries(v as object).map(([k, x]) => [k, py(x)]));
  throw new PyError("TypeError", `unsupported ${typeof v}`);
}

/** Set of string tuples, keyed by their JSON text (Python set of tuples). */
export class TupleSet {
  private readonly map = new Map<string, string[]>();
  constructor(values: Iterable<string[]> = []) {
    for (const v of values) this.add(v);
  }
  add(v: string[]) {
    this.map.set(JSON.stringify(v), v);
  }
  has(v: string[]) {
    return this.map.has(JSON.stringify(v));
  }
  get size() {
    return this.map.size;
  }
  values() {
    return this.map.values();
  }
  intersects(other: TupleSet) {
    for (const k of this.map.keys()) if (other.map.has(k)) return true;
    return false;
  }
}

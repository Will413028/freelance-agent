import { createHash } from "node:crypto";
import { cmpStr, isDict, PyDict, PyError, type PyValue } from "./value";

// json.dumps / json.loads with CPython's exact output (spike 1c rules 2–6).

/** CPython float repr: shortest round-trip digits, scientific when decpt <= -4 or > 16. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mant, expText] = Math.abs(x).toExponential().split("e");
  const digits = mant.replace(".", "");
  const exp = Number(expText), decpt = exp + 1, sign = x < 0 ? "-" : "";
  if (decpt <= -4 || decpt > 16) {
    const m = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    return sign + m + "e" + (exp < 0 ? "-" : "+") + String(Math.abs(exp)).padStart(2, "0");
  }
  if (decpt <= 0) return sign + "0." + "0".repeat(-decpt) + digits;
  if (decpt >= digits.length) return sign + digits + "0".repeat(decpt - digits.length) + ".0";
  return sign + digits.slice(0, decpt) + "." + digits.slice(decpt);
}

export type DumpsOptions = { sortKeys?: boolean; ensureAscii?: boolean; compact?: boolean; allowNan?: boolean };
const SHORT: Record<number, string> = { 0x22: '\\"', 0x5c: "\\\\", 0x0a: "\\n", 0x0d: "\\r", 0x09: "\\t", 0x08: "\\b", 0x0c: "\\f" };
const hex4 = (n: number) => n.toString(16).padStart(4, "0");

function encodeString(s: string, ensureAscii: boolean): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    // UTF-16 units: CPython's \\ud83d\\ude00 output for non-BMP is exactly the unit pair.
    const u = s.charCodeAt(i);
    if (SHORT[u] !== undefined) out += SHORT[u];
    else if (u < 0x20 || (ensureAscii && u > 0x7e)) out += "\\u" + hex4(u);
    else out += s[i];
  }
  return out + '"';
}

export function dumps(v: PyValue, o: DumpsOptions = {}): string {
  const ensureAscii = o.ensureAscii ?? true, allowNan = o.allowNan ?? true;
  const itemSep = o.compact ? "," : ", ", keySep = o.compact ? ":" : ": ";
  const go = (x: PyValue): string => {
    if (x === null) return "null";
    if (typeof x === "boolean") return x ? "true" : "false";
    if (typeof x === "bigint") return x.toString();
    if (typeof x === "number") {
      if (!Number.isFinite(x)) {
        if (!allowNan) throw new PyError("ValueError", "Out of range float values are not JSON compliant");
        return Number.isNaN(x) ? "NaN" : x > 0 ? "Infinity" : "-Infinity";
      }
      return floatRepr(x);
    }
    if (typeof x === "string") return encodeString(x, ensureAscii);
    if (Array.isArray(x)) return "[" + x.map(go).join(itemSep) + "]";
    const entries = o.sortKeys ? [...x].sort((a, b) => cmpStr(a[0], b[0])) : [...x];
    return "{" + entries.map(([k, val]) => encodeString(k, ensureAscii) + keySep + go(val)).join(itemSep) + "}";
  };
  return go(v);
}

/** str.encode(): strict UTF-8, a lone surrogate raises instead of becoming U+FFFD. */
export function utf8Strict(s: string): Buffer {
  if (!s.isWellFormed()) throw new PyError("UnicodeEncodeError");
  return Buffer.from(s, "utf8");
}
export const sha256Hex = (s: string) => createHash("sha256").update(utf8Strict(s)).digest("hex");

/** json.loads, lossless: keeps int vs float, big ints and key order (first position, last value). */
export function loads(text: string): PyValue {
  const [result, end] = scan(text, 0, true);
  let i = end;
  while (i < text.length && " \t\n\r".includes(text[i])) i++;
  if (i !== text.length) throw new PyError("JSONDecodeError");
  return result;
}

/**
 * json.JSONDecoder().raw_decode(text): the first value and the (UTF-16) index after it. Unlike
 * loads, leading whitespace is an error and anything may follow.
 */
export const rawDecode = (text: string): [PyValue, number] => scan(text, 0, false);

function scan(text: string, start: number, skipLeading: boolean): [PyValue, number] {
  let i = start;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const fail = (): never => {
    throw new PyError("JSONDecodeError");
  };
  const str = (): string => {
    i++;
    let out = "";
    for (;;) {
      const c = text[i++];
      if (c === undefined) fail();
      if (c === '"') return out;
      if (c === "\\") {
        const e = text[i++];
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e === "u") {
          const h = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail();
          out += String.fromCharCode(parseInt(h, 16));
          i += 4;
        } else if (simple[e] !== undefined) out += simple[e];
        else fail();
      } else if (c.charCodeAt(0) < 0x20) fail();
      else out += c;
    }
  };
  const LITERALS: [string, PyValue][] = [["null", null], ["true", true], ["false", false], ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity]];
  const value = (): PyValue => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const d = new PyDict();
      ws();
      if (text[i] === "}") { i++; return d; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const k = str();
        ws();
        if (text[i++] !== ":") fail();
        d.set(k, value());
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return d; }
        fail();
      }
    }
    if (c === "[") {
      i++;
      const items: PyValue[] = [];
      ws();
      if (text[i] === "]") { i++; return items; }
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return items; }
        fail();
      }
    }
    if (c === '"') return str();
    for (const [lit, val] of LITERALS) {
      if (text.startsWith(lit, i)) { i += lit.length; return val; }
    }
    const m = /^(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/.exec(text.slice(i));
    if (!m) fail();
    i += m![0].length;
    if (m![2] || m![3]) return Number(m![0]);
    // int() of a JSON integer has CPython's 4300-digit limit; past it the whole document fails.
    if (m![1].replace("-", "").length > 4300) throw new PyError("ValueError", "Exceeds the limit (4300 digits) for integer string conversion");
    return BigInt(m![1]);
  };
  if (!skipLeading && i < text.length && " \t\n\r".includes(text[i])) fail();
  const result = value();
  return [result, i];
}

/** loads() for a stored JSON object column. */
export function loadsDict(text: string): PyDict {
  const v = loads(text);
  if (!isDict(v)) throw new PyError("TypeError", "stored JSON is not an object");
  return v;
}

// Each persisted point keeps its own parameter set (spike 1c rule 6); unifying them would
// change existing fingerprints.

/** HP10 platform.sqlite.encode: insertion order, ensure_ascii=False, default separators. */
export const encode = (v: PyValue) => dumps(v, { ensureAscii: false });
/** HP1 collection.store.identity_hash and discovery.rules._hash. */
export const identityHash = (v: PyValue) => sha256Hex(dumps(v, { sortKeys: true, ensureAscii: false }));
/** HP3 receipts: json.dumps(job, sort_keys=True) with ensure_ascii left at True. */
export const asciiHash = (v: PyValue) => sha256Hex(dumps(v, { sortKeys: true }));
/** HP4 submissions.domain.digest. */
export const submissionDigest = (v: PyValue) =>
  sha256Hex(dumps(v, { sortKeys: true, ensureAscii: false, compact: true, allowNan: false }));

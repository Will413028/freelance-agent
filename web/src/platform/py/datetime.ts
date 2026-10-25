import { codePoints } from "./unicode";
import { PyError } from "./value";

// The slice of Python's datetime the ported rules use. fromisoformat follows CPython 3.13's C
// implementation (Modules/_datetimemodule.c), which works on the UTF-8 bytes and reads past the time
// part into the rest of the NUL-terminated buffer; _pydatetime differs on edge inputs.

const US_PER_DAY = 86_400_000_000n;
const MINYEAR = 1, MAXYEAR = 9999;
const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysInMonth = (y: number, m: number) => (m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m]);
const daysBeforeYear = (y: number) => { const z = y - 1; return z * 365 + Math.floor(z / 4) - Math.floor(z / 100) + Math.floor(z / 400); };
const daysBeforeMonth = (y: number, m: number) => { let n = 0; for (let i = 1; i < m; i++) n += daysInMonth(y, i); return n; };
/** Proleptic Gregorian ordinal, 0001-01-01 = 1. */
const ymdToOrd = (y: number, m: number, d: number) => daysBeforeYear(y) + daysBeforeMonth(y, m) + d;
function ordToYmd(n: number): [number, number, number] {
  let y = Math.floor((n - 1) / 365.2425) + 1;
  while (ymdToOrd(y + 1, 1, 1) <= n) y++;
  while (ymdToOrd(y, 1, 1) > n) y--;
  let rest = n - daysBeforeYear(y), m = 1;
  while (rest > daysInMonth(y, m)) { rest -= daysInMonth(y, m); m++; }
  return [y, m, rest];
}
const EPOCH_ORD = ymdToOrd(1970, 1, 1);

export class PyDateTime {
  constructor(
    readonly year: number, readonly month: number, readonly day: number,
    readonly hour = 0, readonly minute = 0, readonly second = 0, readonly microsecond = 0,
    /** UTC offset in microseconds; null for a naive datetime. */
    readonly offset: bigint | null = null,
  ) {
    if (year < MINYEAR || year > MAXYEAR) throw new PyError("ValueError", `year ${year} is out of range`);
    if (month < 1 || month > 12) throw new PyError("ValueError", "month must be in 1..12");
    if (day < 1 || day > daysInMonth(year, month)) throw new PyError("ValueError", "day is out of range for month");
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 || microsecond < 0 || microsecond > 999_999) {
      throw new PyError("ValueError", "time component out of range");
    }
    if (offset !== null && (offset <= -US_PER_DAY || offset >= US_PER_DAY)) {
      throw new PyError("ValueError", "offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24)");
    }
  }

  static now(): PyDateTime {
    return PyDateTime.fromUtcMicros(BigInt(Date.now()) * 1000n);
  }

  static fromUtcMicros(us: bigint): PyDateTime {
    const days = us >= 0n ? us / US_PER_DAY : -((-us + US_PER_DAY - 1n) / US_PER_DAY);
    let rest = us - days * US_PER_DAY;
    const [y, m, d] = ordToYmd(EPOCH_ORD + Number(days));
    const hour = Number(rest / 3_600_000_000n); rest %= 3_600_000_000n;
    const minute = Number(rest / 60_000_000n); rest %= 60_000_000n;
    const second = Number(rest / 1_000_000n);
    return new PyDateTime(y, m, d, hour, minute, second, Number(rest % 1_000_000n), 0n);
  }

  /**
   * datetime.fromtimestamp(t, tz=timezone.utc), rounding half-even like _PyTime_ObjectToTimeval. The
   * error follows CPython on Linux and macOS (measured 2026-10-24): outside time_t is OverflowError,
   * a year gmtime cannot store in tm_year is OSError, and any other year outside 1..9999 is ValueError.
   */
  static fromTimestamp(t: number | bigint): PyDateTime {
    let whole: bigint, us: bigint;
    if (typeof t === "bigint") { whole = t; us = 0n; }
    else {
      if (Number.isNaN(t)) throw new PyError("ValueError", "Invalid value NaN (not a number)");
      if (!Number.isFinite(t)) throw new PyError("OverflowError", "timestamp out of range for platform time_t");
      const intpart = Math.trunc(t);
      let frac = roundHalfEven((t - intpart) * 1e6), ip = intpart;
      if (frac >= 1e6) { frac -= 1e6; ip += 1; } else if (frac < 0) { frac += 1e6; ip -= 1; }
      if (Math.abs(ip) > 2 ** 63) throw new PyError("OverflowError", "timestamp out of range for platform time_t");
      whole = BigInt(ip); us = BigInt(frac);
    }
    if (whole < -(2n ** 63n) || whole >= 2n ** 63n) throw new PyError("OverflowError", "timestamp out of range for platform time_t");
    const days = whole >= 0n ? whole / 86_400n : -((-whole + 86_399n) / 86_400n);
    const [year] = ordToYmd(EPOCH_ORD + Number(days));
    if (year - 1900 > 2 ** 31 - 1 || year - 1900 < -(2 ** 31)) throw new PyError("OSError", "Value too large for defined data type");
    return PyDateTime.fromUtcMicros(whole * 1_000_000n + us);
  }

  /** fromtimestamp for a JSON value: bool counts as int; anything else non-numeric is a TypeError. */
  static fromTimestampValue(v: unknown): PyDateTime {
    if (typeof v === "boolean") return PyDateTime.fromTimestamp(v ? 1n : 0n);
    if (typeof v === "bigint" || typeof v === "number") return PyDateTime.fromTimestamp(v);
    throw new PyError("TypeError", "'str' object cannot be interpreted as an integer");
  }

  get aware() { return this.offset !== null; }

  /** Microseconds since the epoch of the wall clock, ignoring the offset. */
  private wallMicros(): bigint {
    const days = BigInt(ymdToOrd(this.year, this.month, this.day) - EPOCH_ORD);
    return days * US_PER_DAY + BigInt(this.hour) * 3_600_000_000n + BigInt(this.minute) * 60_000_000n
      + BigInt(this.second) * 1_000_000n + BigInt(this.microsecond);
  }

  utcMicros(): bigint {
    if (this.offset === null) throw new PyError("TypeError", "can't compare offset-naive and offset-aware datetimes");
    return this.wallMicros() - this.offset;
  }

  /** dt.replace(tzinfo=timezone.utc) */
  withUtc(): PyDateTime {
    return new PyDateTime(this.year, this.month, this.day, this.hour, this.minute, this.second, this.microsecond, 0n);
  }

  /** dt.date() as a comparable ordinal. */
  dateOrdinal(): number { return ymdToOrd(this.year, this.month, this.day); }

  /** (self - other).total_seconds() for aware datetimes. */
  secondsSince(other: PyDateTime): number {
    return Number(this.utcMicros() - other.utcMicros()) / 1e6;
  }

  isoformat(): string {
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    let s = `${p(this.year, 4)}-${p(this.month)}-${p(this.day)}T${p(this.hour)}:${p(this.minute)}:${p(this.second)}`;
    if (this.microsecond) s += "." + p(this.microsecond, 6);
    if (this.offset !== null) {
      const sign = this.offset < 0n ? "-" : "+";
      let off = this.offset < 0n ? -this.offset : this.offset;
      const hh = off / 3_600_000_000n; off %= 3_600_000_000n;
      const mm = off / 60_000_000n; off %= 60_000_000n;
      const ss = off / 1_000_000n, us = off % 1_000_000n;
      s += `${sign}${p(Number(hh))}:${p(Number(mm))}`;
      if (ss || us) s += ":" + p(Number(ss));
      if (us) s += "." + p(Number(us), 6);
    }
    return s;
  }
}

function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x - r) === 0.5 ? 2 * Math.round(x / 2) : r;
}

// ---------------------------------------------------------------- fromisoformat (C semantics)
const SEP = 0x2d, WEEK = 0x57;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

class Cursor {
  constructor(readonly b: Uint8Array) {}
  at(i: number) { return i < this.b.length ? this.b[i] : 0; } // NUL past the end
}

function parseDigits(c: Cursor, p: number, n: number): [number, number] | null {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = c.at(p++) - 0x30;
    if (d < 0 || d > 9) return null;
    v = v * 10 + d;
  }
  return [p, v];
}

function findSeparator(c: Cursor, len: number): number {
  if (len === 7) return 7;
  if (c.at(4) === SEP) {
    if (c.at(5) === WEEK) {
      if (len < 8) return -1;
      if (len > 8 && c.at(8) === SEP) {
        if (len === 9) return -1;
        if (len > 10 && isDigit(c.at(10))) return 8;
        return 10;
      }
      return 8;
    }
    return 10;
  }
  if (c.at(4) === WEEK) {
    let idx = 7;
    for (; idx < len; ++idx) if (!isDigit(c.at(idx))) break;
    if (idx < 9) return idx;
    return idx % 2 === 0 ? 7 : 8;
  }
  return 8;
}

function isoToYmd(year: number, week: number, day: number): [number, number, number] | null {
  if (year < MINYEAR || year > MAXYEAR) return null;
  if (week <= 0 || week >= 53) {
    let outOfRange = true;
    if (week === 53) {
      const firstWeekday = (ymdToOrd(year, 1, 1) + 6) % 7; // Monday = 0
      if (firstWeekday === 3 || (firstWeekday === 2 && isLeap(year))) outOfRange = false;
    }
    if (outOfRange) return null;
  }
  if (day <= 0 || day >= 8) return null;
  const jan4 = ymdToOrd(year, 1, 4);
  const week1Monday = jan4 - ((jan4 + 6) % 7);
  return ordToYmd(week1Monday + (week - 1) * 7 + day - 1);
}

function parseDate(c: Cursor, len: number): [number, number, number] | null {
  let r = parseDigits(c, 0, 4);
  if (!r) return null;
  let [p] = r;
  const year = r[1];
  const usesSep = c.at(p) === SEP;
  if (usesSep) p++;
  if (c.at(p) === WEEK) {
    p++;
    r = parseDigits(c, p, 2);
    if (!r) return null;
    [p] = r;
    const week = r[1];
    let day = 1;
    if (p < len) {
      if (usesSep && c.at(p++) !== SEP) return null;
      r = parseDigits(c, p, 1);
      if (!r) return null;
      day = r[1];
    }
    return isoToYmd(year, week, day);
  }
  r = parseDigits(c, p, 2);
  if (!r) return null;
  [p] = r;
  const month = r[1];
  if (usesSep && c.at(p++) !== SEP) return null;
  r = parseDigits(c, p, 2);
  if (!r) return null;
  return [year, month, r[1]];
}

/** parse_hh_mm_ss_ff: [code, hour, minute, second, microsecond]; code 0 ok, 1 trailing data, <0 error. */
function parseHms(c: Cursor, start: number, end: number): [number, number, number, number, number] {
  const vals = [0, 0, 0];
  let p = start, hasSep = true, us = 0;
  for (let i = 0; i < 3; i++) {
    const r = parseDigits(c, p, 2);
    if (!r) return [-3, 0, 0, 0, 0];
    [p, vals[i]] = r;
    const ch = c.at(p++);
    if (i === 0) hasSep = ch === 0x3a;
    // 3.13.15 checks the decimal mark first: a mark with no digit after it is an error.
    if (ch === 0x2e || ch === 0x2c) {
      if (p >= end) return [-3, 0, 0, 0, 0];
      break;
    } else if (p >= end) return [ch !== 0 ? 1 : 0, vals[0], vals[1], vals[2], 0];
    else if (hasSep && ch === 0x3a) continue;
    else if (!hasSep) --p;
    else return [-4, 0, 0, 0, 0];
  }
  const remains = end - p, toParse = remains >= 6 ? 6 : remains;
  const r = parseDigits(c, p, toParse);
  if (!r) return [-3, 0, 0, 0, 0];
  [p, us] = r;
  if (toParse < 6) us *= [100000, 10000, 1000, 100, 10][toParse - 1];
  while (isDigit(c.at(p))) ++p;
  return [c.at(p) !== 0 ? 1 : 0, vals[0], vals[1], vals[2], us];
}

export function fromisoformat(s: unknown): PyDateTime {
  if (typeof s !== "string") throw new PyError("TypeError", "fromisoformat: argument must be str");
  const invalid = () => new PyError("ValueError", `Invalid isoformat string: ${s}`);
  // _sanitize_isoformat_str: a lone surrogate at a separator position becomes 'T'.
  // Positions count code points, as in the C code.
  const cps = codePoints(s);
  for (const pos of [7, 8, 10]) {
    if (pos >= cps.length) break;
    if (cps[pos] >= 0xd800 && cps[pos] <= 0xdfff) { cps[pos] = 0x54; break; }
  }
  const clean = cps.map((cp) => String.fromCodePoint(cp)).join("");
  if (!clean.isWellFormed()) throw invalid();
  const c = new Cursor(new TextEncoder().encode(clean));
  let len = c.b.length;
  const sep = findSeparator(c, len);
  const date = sep < 0 ? null : parseDate(c, sep);
  if (!date) throw invalid();
  let [hour, minute, second, us] = [0, 0, 0, 0];
  let offset: bigint | null = null;
  if (len > sep) {
    let p = sep;
    const lead = c.at(p);
    p += (lead & 0x80) === 0 ? 1 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf0) === 0xf0 ? 4 : 2;
    len -= p;
    const end = p + len;
    let tz = p;
    do {
      const ch = c.at(tz);
      if (ch === 0x5a || ch === 0x2b || ch === 0x2d) break;
    } while (++tz < end);
    const [rv, h, m, sec, micro] = parseHms(c, p, tz);
    if (rv < 0) throw invalid();
    [hour, minute, second, us] = [h, m, sec, micro];
    if (tz === end) {
      if (rv === 1) throw invalid();
    } else if (c.at(tz) === 0x5a) {
      if (c.at(tz + 1) !== 0) throw invalid();
      offset = 0n;
    } else {
      const sign = c.at(tz) === 0x2d ? -1n : 1n;
      const [trv, th, tm, ts, tus] = parseHms(c, tz + 1, end);
      if (trv) throw invalid();
      const secs = sign * BigInt(th * 3600 + tm * 60 + ts);
      // tzinfo_from_isoformat_results as of 3.13.15 (the production image): only a zero offset with
      // zero microseconds is UTC; 3.13.13 also dropped the microseconds of a zero-second offset.
      offset = secs * 1_000_000n + sign * BigInt(tus);
    }
  }
  return new PyDateTime(date[0], date[1], date[2], hour, minute, second, us, offset);
}

/** date.fromisoformat(s).isoformat() (C implementation: 7, 8 or 10 UTF-8 bytes, else ValueError). */
export function dateFromIsoformat(s: string): string {
  const invalid = () => new PyError("ValueError", `Invalid isoformat string: ${s}`);
  if (!s.isWellFormed()) throw invalid();
  const c = new Cursor(new TextEncoder().encode(s));
  const len = c.b.length;
  const date = len === 7 || len === 8 || len === 10 ? parseDate(c, len) : null;
  if (!date) throw invalid();
  const d = new PyDateTime(date[0], date[1], date[2]);
  return `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

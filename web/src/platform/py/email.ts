import { PyDateTime } from "./datetime";
import { codePoints, pyInt, pyIsDigit, pyLower, pySplit, pyUpperAscii } from "./unicode";
import { PyError } from "./value";

// email.utils.parsedate_to_datetime of CPython 3.13.15 (email/_parseaddr.py _parsedate_tz).

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const ZONES: Record<string, number> = {
  UT: 0, UTC: 0, GMT: 0, Z: 0, AST: -400, ADT: -300, EST: -500, EDT: -400, CST: -600, CDT: -500, MST: -700, MDT: -600, PST: -800, PDT: -700,
};

const last = (s: string) => { const c = codePoints(s); return c.length ? String.fromCodePoint(c[c.length - 1]) : ""; };
const dropLast = (s: string) => { const c = codePoints(s); return String.fromCodePoint(...c.slice(0, -1)); };
const tryInt = (s: string) => { try { return pyInt(s); } catch { return null; } };

type Parsed = [bigint, number, bigint, bigint, bigint, bigint, number | null];

function parsedateTz(input: string): Parsed | null {
  if (!input) return null;
  let data = pySplit(input);
  if (!data.length) return null;
  if (data[0].endsWith(",") || DAYS.includes(pyLower(data[0]))) data.shift();
  else {
    const i = data[0].lastIndexOf(",");
    if (i >= 0) data[0] = data[0].slice(i + 1);
  }
  if (data.length === 3) {
    const stuff = data[0].split("-");
    if (stuff.length === 3) data = [...stuff, ...data.slice(1)];
  }
  if (data.length === 4) {
    const s = data[3];
    let i = s.indexOf("+");
    if (i === -1) i = s.indexOf("-");
    if (i > 0) data.splice(3, 1, s.slice(0, i), s.slice(i));
    else data.push("");
  }
  if (data.length < 5) return null;
  let [dd, mm, yy, tm, tz] = data.slice(0, 5);
  if (!(dd && mm && yy)) return null;
  mm = pyLower(mm);
  if (!MONTHS.includes(mm)) {
    [dd, mm] = [mm, pyLower(dd)];
    if (!MONTHS.includes(mm)) return null;
  }
  let month = MONTHS.indexOf(mm) + 1;
  if (month > 12) month -= 12;
  if (last(dd) === ",") dd = dropLast(dd);
  if (yy.indexOf(":") > 0) [yy, tm] = [tm, yy];
  if (last(yy) === ",") {
    yy = dropLast(yy);
    if (!yy) return null;
  }
  if (!pyIsDigit(codePoints(yy)[0])) [yy, tz] = [tz, yy];
  if (last(tm) === ",") tm = dropLast(tm);
  let parts = tm.split(":");
  let thh: string, tmm: string, tss: string;
  if (parts.length === 2) [thh, tmm, tss] = [parts[0], parts[1], "0"];
  else if (parts.length === 3) [thh, tmm, tss] = parts as [string, string, string];
  else if (parts.length === 1 && parts[0].includes(".")) {
    parts = parts[0].split(".");
    if (parts.length === 2) [thh, tmm, tss] = [parts[0], parts[1], "0"];
    else if (parts.length === 3) [thh, tmm, tss] = parts as [string, string, string];
    else return null;
  } else return null;
  const nums = [yy, dd, thh, tmm, tss].map(tryInt);
  if (nums.some((n) => n === null)) return null;
  let [year, day, hh, mi, ss] = nums as bigint[];
  if (year < 100n) year += year > 68n ? 1900n : 2000n;
  let offset: bigint | null = null;
  const zone = pyUpperAscii(tz);
  if (Object.hasOwn(ZONES, zone)) offset = BigInt(ZONES[zone]);
  else {
    offset = tryInt(zone);
    if (offset === 0n && zone.startsWith("-")) offset = null;
  }
  let seconds: number | null = offset === null ? null : 0;
  if (offset) {
    const sign = offset < 0n ? -1n : 1n, abs = offset < 0n ? -offset : offset;
    const value = sign * ((abs / 100n) * 3600n + (abs % 100n) * 60n);
    seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) seconds = Number.MAX_SAFE_INTEGER; // past timezone()'s range either way
  }
  return [year, month, day, hh, mi, ss, seconds];
}

/** email.utils.parsedate_to_datetime; every failure is a ValueError, as in Python. */
export function parsedateToDatetime(data: string): PyDateTime {
  const parsed = parsedateTz(data);
  const invalid = () => new PyError("ValueError", `Invalid date value or format "${data}"`);
  if (parsed === null) throw invalid();
  const [year, month, day, hh, mi, ss, tz] = parsed;
  const small = (n: bigint) => (n >= -(2n ** 31n) && n < 2n ** 31n ? Number(n) : null);
  const fields = [year, day, hh, mi, ss].map(small);
  // CPython raises OverflowError past a C int, which parsedate_to_datetime turns into ValueError.
  if (fields.some((n) => n === null)) throw invalid();
  const [y, d, h, m, s] = fields as number[];
  return new PyDateTime(y, month, d, h, m, s, 0, tz === null ? null : BigInt(tz) * 1_000_000n);
}

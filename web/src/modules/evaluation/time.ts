// ISO 8601 text to instants, natively (no Python datetime port). Accepted, in extended or basic form:
// a date `YYYY-MM-DD` / `YYYYMMDD`, optionally followed by `T` or a space and a time `HH[:MM[:SS[.fraction]]]`
// with an optional `Z` or `±HH[:MM[:SS[.fraction]]]` offset (the forms Python's datetime.fromisoformat
// accepts for calendar dates; 3b checks them against the golden fromisoformat cases).

const DATE = /^(\d{4})(-?)(\d{2})\2(\d{2})$/;
const TIME = /^(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,9}))?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:[.,]\d{1,6})?)?)?)?$/;

export type ParsedTime =
  | { kind: "date"; year: number; month: number; day: number }
  | { kind: "aware"; instant: Date }
  | { kind: "naive"; utcIfAssumed: Date };

function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 1;
}

/** Parses ISO text; null when it is not one of the accepted forms or names an impossible date or time. */
export function parseIsoTime(text: string): ParsedTime | null {
  const split = /^(\d{4}-\d{2}-\d{2}|\d{8})(?:[T ](.+))?$/.exec(text);
  const dm = split && DATE.exec(split[1]);
  if (!split || !dm) return null;
  const [y, mo, d] = [Number(dm[1]), Number(dm[3]), Number(dm[4])];
  if (!validDate(y, mo, d)) return null;
  if (split[2] === undefined) return { kind: "date", year: y, month: mo, day: d };
  const m = TIME.exec(split[2]);
  if (!m) return null;
  const [h, mi, s] = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const ms = m[4] ? Math.floor(Number(`0.${m[4]}`) * 1000) : 0;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (!m[5]) return { kind: "naive", utcIfAssumed: new Date(utc) };
  if (m[5] === "Z") return { kind: "aware", instant: new Date(utc) };
  const o = /^([+-])(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6}))?)?)?$/.exec(m[5])!;
  const [oh, om, os] = [Number(o[2]), Number(o[3] ?? 0), Number(o[4] ?? 0)];
  if (oh > 23 || om > 59 || os > 59) return null;
  const offset = (o[1] === "-" ? -1 : 1) * (((oh * 60 + om) * 60 + os) * 1000 + (o[5] ? Math.floor(Number(`0.${o[5]}`) * 1000) : 0));
  return { kind: "aware", instant: new Date(utc - offset) };
}

/** Asia/Taipei is UTC+8 with no daylight saving time. */
const TAIPEI_OFFSET_MS = 8 * 3_600_000;

/** The instant a date-only deadline expires: the next day's 00:00 in Asia/Taipei (plan D7). */
export const taipeiDayAfter = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day + 1) - TAIPEI_OFFSET_MS);

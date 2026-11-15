// ISO 8601 text to instants, natively (no Python datetime port). Accepted: a date `YYYY-MM-DD`, or a
// date and time `YYYY-MM-DD[T ]HH:MM[:SS[.fraction]]` with an optional `Z` or `±HH:MM[:SS]` offset.

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2}(?::?\d{2})?)?)?$/;

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
  const m = ISO.exec(text.trim() === text ? text : "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!validDate(y, mo, d)) return null;
  if (m[4] === undefined) return { kind: "date", year: y, month: mo, day: d };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (!m[8]) return { kind: "naive", utcIfAssumed: new Date(utc) };
  if (m[8] === "Z") return { kind: "aware", instant: new Date(utc) };
  const o = /^([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?$/.exec(m[8])!;
  const [oh, om, os] = [Number(o[2]), Number(o[3]), Number(o[4] ?? 0)];
  if (oh > 23 || om > 59 || os > 59) return null;
  const offset = (o[1] === "-" ? -1 : 1) * ((oh * 60 + om) * 60 + os) * 1000;
  return { kind: "aware", instant: new Date(utc - offset) };
}

/** Asia/Taipei is UTC+8 with no daylight saving time. */
const TAIPEI_OFFSET_MS = 8 * 3_600_000;

/** The instant a date-only deadline expires: the next day's 00:00 in Asia/Taipei (plan D7). */
export const taipeiDayAfter = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day + 1) - TAIPEI_OFFSET_MS);

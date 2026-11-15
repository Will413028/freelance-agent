// Python's datetime.fromisoformat (3.11+), natively, for text written by the old system only (plan
// D8: the new contract takes RFC 3339; this reads what old connectors stored, for the step 10
// migration and the golden conversion). legacy-time.fixtures.json holds golden's 61 cases.
// Accepted: a date `YYYY-MM-DD`, `YYYYMMDD`, or ISO week `YYYY-Www[-D]` / `YYYYWww[D]`; then any one
// character and a time `HH[:MM[:SS[(.|,|:)fraction]]]` (or basic `HHMMSS`), with an optional `Z` or
// `±HH[:MM[:SS[.fraction]]]` offset. Fractions keep milliseconds (JavaScript Date).

export type ParsedTime =
  | { kind: "date"; year: number; month: number; day: number }
  | { kind: "aware"; instant: Date }
  | { kind: "naive"; utcIfAssumed: Date };

const TIME = /^(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,:](\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:[.,]\d{1,6})?)?)?)?$/;

/** Date.UTC reads years 0–99 as 1900–1999; this does not. */
export function utc(y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  const t = new Date(Date.UTC(2000, m - 1, d, h, mi, s, ms));
  t.setUTCFullYear(y + t.getUTCFullYear() - 2000);
  return t.getTime();
}

function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(utc(y, m, d));
  return y >= 1 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** ISO week date to the calendar: week 1 holds January 4; null for a week or day the year lacks. */
function fromWeek(y: number, w: number, d: number): { year: number; month: number; day: number } | null {
  if (w < 1 || d < 1 || d > 7) return null;
  const jan4 = new Date(utc(y, 1, 4)), jan1 = new Date(utc(y, 1, 1)).getUTCDay();
  const leap = new Date(utc(y, 2, 29)).getUTCMonth() === 1;
  if (w > (jan1 === 4 || (leap && jan1 === 3) ? 53 : 52)) return null;
  const monday1 = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000;
  const t = new Date(monday1 + ((w - 1) * 7 + (d - 1)) * 86_400_000);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function parseDate(s: string): { year: number; month: number; day: number } | null {
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)) || (m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDate(y, mo, d) ? { year: y, month: mo, day: d } : null;
  }
  if ((m = /^(\d{4})-W(\d{2})(?:-(\d))?$/.exec(s)) || (m = /^(\d{4})W(\d{2})(\d)?$/.exec(s))) {
    return fromWeek(Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3]));
  }
  return null;
}

/** How many characters the date takes at the start of s, as fromisoformat finds its separator. */
function dateLength(s: string): number {
  if (s[4] === "-") return s[5] === "W" ? (s[8] === "-" ? 10 : 8) : 10;
  if (s[4] === "W") return /\d/.test(s[7] ?? "") ? 8 : 7;
  return 8;
}

const fraction = (digits: string | undefined) => (digits ? Number(digits.slice(0, 3).padEnd(3, "0")) : 0);

/** Parses ISO text as fromisoformat does; null where it raises ValueError. */
export function parseIsoTime(text: string): ParsedTime | null {
  const len = dateLength(text);
  const date = parseDate(text.slice(0, len));
  if (!date) return null;
  if (text.length === len) return { kind: "date", ...date };
  const time = Array.from(text.slice(len)).slice(1).join("");
  const m = TIME.exec(time);
  if (!m) return null;
  const [h, mi, s] = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const at = utc(date.year, date.month, date.day, h, mi, s, fraction(m[4]));
  if (!m[5]) return { kind: "naive", utcIfAssumed: new Date(at) };
  if (m[5] === "Z") return { kind: "aware", instant: new Date(at) };
  const o = /^([+-])(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6}))?)?)?$/.exec(m[5])!;
  const [oh, om, os] = [Number(o[2]), Number(o[3] ?? 0), Number(o[4] ?? 0)];
  if (oh > 23 || om > 59 || os > 59) return null;
  const offsetMs = (o[1] === "-" ? -1 : 1) * (((oh * 60 + om) * 60 + os) * 1000 + fraction(o[5]));
  return { kind: "aware", instant: new Date(at - offsetMs) };
}

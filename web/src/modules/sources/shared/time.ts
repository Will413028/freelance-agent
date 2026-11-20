// Source times as the contract's RFC 3339 instants (plan D8), read by the standard formats the sources
// send (plan step 12d; time.fixtures.json names the sources each format was seen in): ISO 8601's extended
// calendar form as RFC 3339 profiles it, plus a space separator, optional seconds and a ±HHMM offset; and
// RFC 5322's date-time. Anything else is unknown (null), never guessed. A source decides what a time
// without an offset means.

export type ParsedTime =
  | { kind: "date"; year: number; month: number; day: number }
  | { kind: "aware"; instant: Date }
  | { kind: "naive"; utcIfAssumed: Date };

/** Milliseconds of a UTC time; years 0–99 stay as written (Date.UTC would read them as 1900–1999). */
function utc(y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  const t = new Date(Date.UTC(2000, m - 1, d, h, mi, s, ms));
  t.setUTCFullYear(y);
  return t.getTime();
}

const validDate = (y: number, m: number, d: number): boolean => {
  const t = new Date(utc(y, m, d));
  return y >= 1 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?([Zz]|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** An ISO 8601 date or date-time; null when it is not one of the forms above or names no real time. */
export function parseIsoTime(text: string): ParsedTime | null {
  const m = ISO.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!validDate(y, mo, d)) return null;
  if (m[4] === undefined) return { kind: "date", year: y, month: mo, day: d };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const at = utc(y, mo, d, h, mi, s, m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0);
  const zone = m[8];
  if (zone === undefined) return { kind: "naive", utcIfAssumed: new Date(at) };
  if (zone === "Z" || zone === "z") return { kind: "aware", instant: new Date(at) };
  const offset = offsetMinutes(zone);
  return offset === null ? null : { kind: "aware", instant: new Date(at - offset * 60_000) };
}

/** `±HH`, `±HH:MM` or `±HHMM` as minutes east of UTC; null outside a day. */
function offsetMinutes(zone: string): number | null {
  const o = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone)!;
  const [oh, om] = [Number(o[2]), Number(o[3] ?? 0)];
  if (oh > 23 || om > 59) return null;
  return (o[1] === "-" ? -1 : 1) * (oh * 60 + om);
}

const rfc3339 = (d: Date) => {
  const y = d.getUTCFullYear();
  return Number.isFinite(d.getTime()) && y >= 1 && y <= 9999 ? d.toISOString() : null;
};

/** Unix seconds as an instant; null when not a positive finite number (unknown, D8). */
export const epochInstant = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? rfc3339(new Date(value * 1000)) : null;

/** An ISO 8601 time that carries its offset; a time without one, or not a time, is null (unknown, D8). */
export function awareInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = parseIsoTime(value.trim());
  return t?.kind === "aware" ? rfc3339(t.instant) : null;
}

/** An instant for published_at where the source sends times in UTC: a naive time or a date reads as UTC. */
export function utcInstant(text: string): string | null {
  const t = parseIsoTime(text.trim());
  if (t === null) return null;
  if (t.kind === "aware") return rfc3339(t.instant);
  if (t.kind === "naive") return rfc3339(t.utcIfAssumed);
  return rfc3339(new Date(utc(t.year, t.month, t.day)));
}

// RFC 5322 §3.3 date-time, with its obsolete forms a feed still sends: a trailing comment (CFWS), a two-digit year (§4.3: below 50
// is 20xx, otherwise 19xx) and the US zone names. `-0000` means the zone is unknown (§3.3), so is any
// other name; both are null.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ZONES: Record<string, number> = { ut: 0, utc: 0, gmt: 0, z: 0, est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420 };
const RFC5322 = /^(?:(?:mon|tue|wed|thu|fri|sat|sun),\s*)?(\d{1,2})\s+([a-z]{3})\s+(\d{4}|\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|[a-z]+)(?:\s*\([^()]*\))?$/i;

/** An RFC 5322 date-time with a known zone as an instant; null otherwise. */
export function rfc2822Instant(text: string): string | null {
  const m = RFC5322.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
  let year = Number(m[3]);
  if (m[3].length === 2) year += year < 50 ? 2000 : 1900;
  const [day, h, mi, s] = [Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (month === 0 || !validDate(year, month, day) || h > 23 || mi > 59 || s > 59) return null;
  const zone = m[7].toLowerCase();
  const offset = zone === "-0000" ? null : /^[+-]/.test(zone) ? offsetMinutes(zone) : ZONES[zone] ?? null;
  return offset === null ? null : rfc3339(new Date(utc(year, month, day, h, mi, s) - offset * 60_000));
}

/** pubDate as an instant: ISO 8601 or RFC 5322 with a zone; a time without a zone is unknown. */
export function pubDateInstant(text: string): string | null {
  const iso = parseIsoTime(text.trim());
  if (iso) return iso.kind === "aware" ? rfc3339(iso.instant) : null;
  return rfc2822Instant(text);
}

import { parseLegacyIsoTime } from "@/modules/listings/public";

// A source's ISO 8601 time as the contract's RFC 3339 instant (plan D8), through the one ISO parser
// the codebase keeps (listings/legacy-time.ts: the forms Python's fromisoformat read, so a board's
// times parse as they did). A source decides what a time without an offset means.

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
  const t = parseLegacyIsoTime(value.trim().replaceAll("Z", "+00:00"));
  return t?.kind === "aware" ? rfc3339(t.instant) : null;
}

/** An instant for published_at where the source sends times in UTC: a naive time or a date reads as UTC. */
export function utcInstant(text: string): string | null {
  const t = parseLegacyIsoTime(text.replaceAll("Z", "+00:00"));
  if (t === null) return null;
  if (t.kind === "aware") return rfc3339(t.instant);
  if (t.kind === "naive") return rfc3339(t.utcIfAssumed);
  const d = new Date(Date.UTC(2000, t.month - 1, t.day));
  d.setUTCFullYear(t.year);
  return rfc3339(d);
}

// RFC 2822 dates, read as Python's email.utils.parsedate_to_datetime read them (_parsedate_tz, then
// datetime): the same tokens, fallbacks and zone table, so the old reader's times come out the same.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const ZONES: Record<string, number> = { UT: 0, UTC: 0, GMT: 0, Z: 0, AST: -400, ADT: -300, EST: -500, EDT: -400, CST: -600, CDT: -500, MST: -700, MDT: -600, PST: -800, PDT: -700 };

/**
 * Python's int() on a token: surrounding whitespace, a sign, digits with single underscores between them.
 * Non-ASCII digits, which Python also read, are not (accepted: feeds send ASCII; they become unknown).
 */
const pyInt = (s: string): number | null => (/^\s*[+-]?\d+(?:_\d+)*\s*$/.test(s) ? Number(s.replaceAll("_", "").trim()) : null);

/** _parsedate_tz: [year, month, day, hour, minute, second, offset seconds or null], or null when unreadable. */
function parsedateTz(data: string): [number, number, number, number, number, number, number | null] | null {
  let d = data.split(/\s+/).filter(Boolean);
  if (!d.length) return null;
  if (d[0].endsWith(",") || DAYS.includes(d[0].toLowerCase())) d.shift();
  else {
    const i = d[0].lastIndexOf(",");
    if (i >= 0) d[0] = d[0].slice(i + 1);
  }
  if (d.length === 3) {
    const stuff = d[0].split("-");
    if (stuff.length === 3) d = [...stuff, ...d.slice(1)];
  }
  if (d.length === 4) {
    const s = d[3];
    let i = s.indexOf("+");
    if (i === -1) i = s.indexOf("-");
    if (i > 0) d.splice(3, 1, s.slice(0, i), s.slice(i));
    else d.push("");
  }
  if (d.length < 5) return null;
  let [dd, mm, yy, tm, tz] = d.slice(0, 5);
  if (!(dd && mm && yy)) return null;
  mm = mm.toLowerCase();
  if (!MONTHS.includes(mm)) {
    [dd, mm] = [mm, dd.toLowerCase()];
    if (!MONTHS.includes(mm)) return null;
  }
  let month = MONTHS.indexOf(mm) + 1;
  if (month > 12) month -= 12;
  if (dd.endsWith(",")) dd = dd.slice(0, -1);
  if (yy.indexOf(":") > 0) [yy, tm] = [tm, yy];
  if (yy.endsWith(",")) {
    yy = yy.slice(0, -1);
    if (!yy) return null;
  }
  if (!/^\p{Nd}/u.test(yy)) [yy, tz] = [tz, yy];
  if (tm.endsWith(",")) {
    tm = tm.slice(0, -1);
    if (!tm) return null;
  }
  let parts = tm.split(":");
  if (parts.length === 1 && tm.includes(".")) parts = tm.split(".");
  if (parts.length === 2) parts.push("0");
  if (parts.length !== 3) return null;
  const nums = [yy, dd, ...parts].map(pyInt);
  if (nums.some((n) => n === null)) return null;
  let [year, day, hour, minute, second] = nums as number[];
  if (year < 100) year += year > 68 ? 1900 : 2000;
  const upper = tz.toUpperCase();
  let offset: number | null = upper in ZONES ? ZONES[upper] : pyInt(tz);
  if (offset === 0 && tz.startsWith("-")) offset = null;
  if (offset) offset = Math.sign(offset) * (Math.floor(Math.abs(offset) / 100) * 3600 + (Math.abs(offset) % 100) * 60);
  return [year, month, day, hour, minute, second, offset];
}

/** An RFC 2822 date with a zone as an instant; null when Python's parsedate_to_datetime failed or gave a naive time. */
export function rfc2822Instant(text: string): string | null {
  const p = parsedateTz(text);
  if (p === null) return null;
  const [year, month, day, hour, minute, second, offset] = p;
  // datetime's own checks: field ranges, and a zone strictly within a day.
  if (offset === null || Math.abs(offset) >= 86_400 || year < 1 || year > 9999 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const d = new Date(Date.UTC(2000, month - 1, day, hour, minute, second));
  d.setUTCFullYear(year);
  if (d.getUTCDate() !== day || d.getUTCMonth() !== month - 1) return null;
  // The contract's instants are RFC 3339, years 1-9999 in UTC; one past that is unknown.
  return rfc3339(new Date(d.getTime() - offset * 1000));
}

/** pubDate as an instant: ISO 8601 or RFC 2822 with a zone; a time without a zone is unknown, as the old reader refused it. */
export function pubDateInstant(text: string): string | null {
  const iso = parseLegacyIsoTime(text.replaceAll("Z", "+00:00"));
  if (iso) return iso.kind === "aware" ? rfc3339(iso.instant) : null;
  return rfc2822Instant(text);
}

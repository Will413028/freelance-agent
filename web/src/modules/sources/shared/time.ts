// A source's ISO 8601 time as the contract's RFC 3339 instant (plan D8). The forms the free boards
// send: a date, or a date and time with `T` or a space, optional seconds and fraction, and an offset
// `Z`, `±HH:MM` or `±HHMM`. A source decides what a time without an offset means.

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export type IsoTime = { kind: "aware"; at: string } | { kind: "naive"; utcIfAssumed: string } | { kind: "date"; date: string };

/** A real calendar time from year 1 to 9999, or null for anything else. */
export function parseIsoTime(text: string): IsoTime | null {
  const m = ISO.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "00", frac = "", off] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (year < 1) return null;
  const dayMs = Date.UTC(year, month - 1, day);
  const probe = new Date(dayMs);
  probe.setUTCFullYear(year);
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  if (h === undefined) return { kind: "date", date: `${y}-${mo}-${d}` };
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  const local = new Date(Date.UTC(2000, 0, 1, Number(h), Number(mi), Number(s), Number(frac.padEnd(3, "0").slice(0, 3))));
  local.setUTCFullYear(year, month - 1, day);
  if (off === undefined) return { kind: "naive", utcIfAssumed: local.toISOString() };
  let offsetMin = 0;
  if (off !== "Z") {
    const digits = off.replace(":", "");
    const oh = Number(digits.slice(1, 3)), om = Number(digits.slice(3, 5));
    if (oh > 23 || om > 59) return null;
    offsetMin = (off[0] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const at = new Date(local.getTime() - offsetMin * 60_000);
  const ay = at.getUTCFullYear();
  if (ay < 1 || ay > 9999) return null;
  return { kind: "aware", at: at.toISOString() };
}

/** An instant for published_at where the source sends times in UTC: a naive time or a date reads as UTC. */
export function utcInstant(text: string): string | null {
  const t = parseIsoTime(text);
  if (t === null) return null;
  return t.kind === "aware" ? t.at : t.kind === "naive" ? t.utcIfAssumed : `${t.date}T00:00:00.000Z`;
}

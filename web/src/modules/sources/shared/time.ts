import { parseLegacyIsoTime } from "@/modules/listings/public";

// A source's ISO 8601 time as the contract's RFC 3339 instant (plan D8), through the one ISO parser
// the codebase keeps (listings/legacy-time.ts: the forms Python's fromisoformat read, so a board's
// times parse as they did). A source decides what a time without an offset means.

const rfc3339 = (d: Date) => {
  const y = d.getUTCFullYear();
  return Number.isFinite(d.getTime()) && y >= 1 && y <= 9999 ? d.toISOString() : null;
};

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

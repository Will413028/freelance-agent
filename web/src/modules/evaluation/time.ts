/** Asia/Taipei is UTC+8 with no daylight saving time. */
const TAIPEI_OFFSET_MS = 8 * 3_600_000;

/** The instant a date-only deadline expires: the next day's 00:00 in Asia/Taipei (plan D7). */
export function taipeiDayAfter(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(2000, m - 1, d + 1));
  t.setUTCFullYear(y + t.getUTCFullYear() - 2000); // Date.UTC alone reads years 0–99 as 1900–1999
  return new Date(t.getTime() - TAIPEI_OFFSET_MS);
}

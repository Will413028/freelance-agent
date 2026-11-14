import { and, desc, eq } from "drizzle-orm";
import { retrying, type Db } from "@/db/client";
import { dailyRuns } from "@/db/schema";
import { PyDateTime } from "@/platform/py/datetime";
import { encode, loads } from "@/platform/py/json";
import { PyError, type PyValue } from "@/platform/py/value";

// Port of the daily_runs part of notifications/store.py and the gate in notifications/daily.py:
// one claim per Taipei day (the key was (day, recipient) until migration 0005: one person, no mail); an interrupted run stays `running` and is never retried.

/** Taiwan has kept UTC+8 without DST since 1979, so a fixed offset equals ZoneInfo('Asia/Taipei'). */
export function taipeiLocal(now: PyDateTime): { date: string; hour: number } {
  const local = PyDateTime.fromUtcMicros(now.utcMicros() + 8n * 3_600_000_000n);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return { date: `${p(local.year, 4)}-${p(local.month)}-${p(local.day)}`, hour: local.hour };
}

/**
 * INSERT … ON CONFLICT DO NOTHING: true only for the first claim of the day. When a response is lost
 * the insert is sent again; if the lost one had committed, the row carries this claim's started_at,
 * so reading it back tells this claim from another one.
 */
export async function claimDailyRun(db: Db, localDate: string, now: PyDateTime): Promise<boolean> {
  const startedAt = now.isoformat();
  const rows = await retrying(() => db.insert(dailyRuns).values({ localDate, status: "running", startedAt })
    .onConflictDoNothing().returning({ localDate: dailyRuns.localDate }));
  if (rows.length === 1) return true;
  return (await getDailyRun(db, localDate))?.startedAt === startedAt;
}

export async function getDailyRun(db: Db, localDate: string) {
  const [row] = await retrying(() => db.select().from(dailyRuns).where(eq(dailyRuns.localDate, localDate)));
  return row ? { ...row, result: row.result === null ? null : loads(row.result) } : null;
}

/** The most recent day's run, for the sources page (plan step 11); null before the first run. */
export async function latestDailyRun(db: Db) {
  const [row] = await retrying(() => db.select().from(dailyRuns).orderBy(desc(dailyRuns.localDate), desc(dailyRuns.startedAt)).limit(1));
  return row ? { ...row, result: row.result === null ? null : loads(row.result) } : null;
}

/** Only a running claim can finish; a finished day is never rewritten, so sending it twice is harmless. */
export async function finishDailyRun(db: Db, localDate: string, status: string, result: PyValue, now: PyDateTime) {
  if (status !== "complete" && status !== "failed") throw new PyError("ValueError", "Invalid daily run outcome");
  await retrying(() => db.update(dailyRuns).set({ status, result: encode(result), finishedAt: now.isoformat() })
    .where(and(eq(dailyRuns.localDate, localDate), eq(dailyRuns.status, "running"))));
}

import { and, eq } from "drizzle-orm";
import { readTransaction, writeTransaction, type Db } from "@/db/client";
import { dailyRuns } from "@/db/schema";
import { PyDateTime } from "@/platform/py/datetime";
import { encode, loads } from "@/platform/py/json";
import { casefold, pyStrip } from "@/platform/py/unicode";
import { PyError, type PyValue } from "@/platform/py/value";

// Port of the daily_runs part of notifications/store.py and the gate in notifications/daily.py:
// one claim per Taipei day and recipient; an interrupted run stays `running` and is never retried.

/** Taiwan has kept UTC+8 without DST since 1979, so a fixed offset equals ZoneInfo('Asia/Taipei'). */
export function taipeiLocal(now: PyDateTime): { date: string; hour: number } {
  const local = PyDateTime.fromUtcMicros(now.utcMicros() + 8n * 3_600_000_000n);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return { date: `${p(local.year, 4)}-${p(local.month)}-${p(local.day)}`, hour: local.hour };
}

/** run_daily's recipient rules: explicit, single line, stripped and casefolded. Read inside steps only. */
export function dailyRecipient(value = process.env.DIGEST_RECIPIENT): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw new PyError("ValueError", "Explicit recipient required");
  return casefold(pyStrip(value));
}

/** INSERT … ON CONFLICT DO NOTHING: true only for the first claim of the day. */
export async function claimDailyRun(db: Db, localDate: string, recipient: string, now: PyDateTime): Promise<boolean> {
  return writeTransaction(db, async (tx) => {
    const rows = await tx.insert(dailyRuns).values({ localDate, recipient, status: "running", startedAt: now.isoformat() })
      .onConflictDoNothing().returning({ localDate: dailyRuns.localDate });
    return rows.length === 1;
  });
}

export async function getDailyRun(db: Db, localDate: string, recipient: string) {
  const [row] = await readTransaction(db, (tx) => tx.select().from(dailyRuns)
    .where(and(eq(dailyRuns.localDate, localDate), eq(dailyRuns.recipient, recipient))));
  return row ? { ...row, result: row.result === null ? null : loads(row.result) } : null;
}

/** Only a running claim can finish; a finished day is never rewritten. */
export async function finishDailyRun(db: Db, localDate: string, recipient: string, status: string, result: PyValue, now: PyDateTime) {
  if (status !== "complete" && status !== "failed") throw new PyError("ValueError", "Invalid daily run outcome");
  await writeTransaction(db, (tx) => tx.update(dailyRuns).set({ status, result: encode(result), finishedAt: now.isoformat() })
    .where(and(eq(dailyRuns.localDate, localDate), eq(dailyRuns.recipient, recipient), eq(dailyRuns.status, "running"))));
}

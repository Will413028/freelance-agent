import { sql } from "drizzle-orm";
import { check, pgTable, text } from "drizzle-orm/pg-core";

// Timestamps stay text in SQLite's CURRENT_TIMESTAMP format so migrated rows keep their exact values.
const utcNowText = sql`to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')`;

export const sourceHealth = pgTable(
  "source_health",
  {
    source: text("source").primaryKey(),
    status: text("status").notNull(),
    checkedAt: text("checked_at").notNull().default(utcNowText),
  },
  (t) => [check("source_health_status", sql`${t.status} in ('not_connected', 'ok', 'failed', 'waiting')`)],
);

export type SourceStatus = "not_connected" | "ok" | "failed" | "waiting";

import { date, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// The Postgres schema of the self-hosted rebuild (docs/plans/2026-11-15-self-hosted-rebuild.md).
// Step 2 holds only the walking skeleton's minimum; step 3 defines the real listing shape.

export const listings = pgTable("listings", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("listings_source_external_id").on(t.source, t.externalId)]);

/** One daily run per Asia/Taipei day. */
export const runs = pgTable("runs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  day: date("day").notNull().unique(),
  status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

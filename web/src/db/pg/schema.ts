import { sql } from "drizzle-orm";
import {
  boolean, check, date, doublePrecision, foreignKey, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";

// The Postgres schema of the self-hosted rebuild (docs/plans/2026-11-15-self-hosted-rebuild.md),
// designed in docs/plans/2026-11-15-self-hosted-rebuild/step-3-design.md. Tri-state facts are
// nullable booleans: null is unknown, never false.

const at = (name: string) => timestamp(name, { withTimezone: true });

/** Closed value lists, shared by the column types, the CHECK constraints and the modules. */
export const KINDS = ["fixed", "hourly", "contract", "full_time"] as const;
/** How a deadline was given (plan D8): a date, an instant, a local time without a zone, or text that is not a date. */
export const DEADLINE_KINDS = ["date", "instant", "no_timezone", "invalid"] as const;
export const FEEDBACK_STATES = ["neutral", "interested", "skipped"] as const;
export const CATEGORIES = ["AI agent", "AI 整合／自動化", "後端／API", "全端 MVP"] as const;

/** `col in ('a', 'b')` for a CHECK; the values are this file's literals, never input. */
const oneOf = (col: unknown, values: readonly string[]) => sql`${col} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;

/**
 * A listing's shown content and the evaluation facts that depend on neither the settings nor the
 * time (written by modules/listings; modules/evaluation computes them). listings and
 * listing_versions both carry this set.
 */
const content = () => ({
  fingerprint: text("fingerprint").notNull(),
  raw: jsonb("raw").notNull(),
  title: text("title").notNull(),
  company: text("company"),
  description: text("description"),
  url: text("url"),
  canonicalUrl: text("canonical_url"),
  location: text("location"),
  kind: text("kind", { enum: KINDS }),
  currency: text("currency"),
  budgetMin: doublePrecision("budget_min"),
  budgetMax: doublePrecision("budget_max"),
  weeklyHours: doublePrecision("weekly_hours"),
  taiwanEligible: boolean("taiwan_eligible"),
  timezoneCompatible: boolean("timezone_compatible"),
  complete: boolean("complete"),
  listingClosed: boolean("listing_closed"),
  compensationEvidence: text("compensation_evidence"),
  publishedAt: at("published_at"),
  /** Null when no deadline was given; deadline_text is what the source said, deadline_at the expiry when usable. */
  deadlineKind: text("deadline_kind", { enum: DEADLINE_KINDS }),
  deadlineText: text("deadline_text"),
  deadlineAt: at("deadline_at"),
  category: text("category").notNull(),
  categoryScore: smallint("category_score").notNull(),
  hardExcluded: boolean("hard_excluded").notNull(),
  confirmedBase: smallint("confirmed_base").notNull(),
  fixedTwdMax: doublePrecision("fixed_twd_max"),
});

const kindCheck = (name: string, kind: unknown) => check(name, oneOf(kind, KINDS));
/** deadline_at exists exactly for a usable deadline, and deadline_text exactly for a given one. */
const deadlineChecks = (prefix: string, t: { deadlineKind: unknown; deadlineText: unknown; deadlineAt: unknown }) => [
  check(`${prefix}_deadline_kind`, oneOf(t.deadlineKind, DEADLINE_KINDS)),
  check(`${prefix}_deadline_at`, sql`(${t.deadlineAt} is not null) = coalesce(${t.deadlineKind} in ('date', 'instant'), false)`),
  check(`${prefix}_deadline_text`, sql`(${t.deadlineText} is not null) = (${t.deadlineKind} is not null)`),
];

export const listings = pgTable("listings", {
  /** Surrogate key (plan D10); a listing's identity is (source, external_id). */
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  source: text("source").notNull(),
  externalId: text("external_id").notNull(),
  ...content(),
  /**
   * The source's own per-listing rule on the current content (plan D9): intake stores every listing read,
   * the listing query keeps the ones with source_kept. Mail listings have no source rule and store true.
   */
  sourceKept: boolean("source_kept").notNull(),
  firstSeenAt: at("first_seen_at").notNull().defaultNow(),
  /** When content last changed (a sighting with the same content leaves it). */
  updatedAt: at("updated_at").notNull().defaultNow(),
  /** When a read last showed the listing, whatever its content (plan D9). */
  lastSeenAt: at("last_seen_at").notNull().defaultNow(),
  /**
   * Set when a complete read of a source marked complete in the catalog no longer showed the listing;
   * cleared when a read shows it again. Null for sources whose reads are never complete (plan D9).
   */
  goneAt: at("gone_at"),
}, (t) => [
  uniqueIndex("listings_source_external_id").on(t.source, t.externalId),
  /**
   * The first branch of the listing query's filter (modules/evaluation/list.ts shownWhere). While that filter ORs in the
   * version and feedback branches Postgres may not use it; 5a2-3 measures the VM page and keeps, reshapes or drops it.
   */
  index("listings_shown").on(t.id).where(sql`${t.sourceKept} and not ${t.hardExcluded}`),
  kindCheck("listings_kind", t.kind),
  ...deadlineChecks("listings", t),
  check("listings_confirmed_base", sql`${t.confirmedBase} between 0 and 3`),
]);

/** Contradicting contents of one mail listing (step-3-design.md core choice 4): the listing row stays as first written. */
export const listingVersions = pgTable("listing_versions", {
  listingId: integer("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  ...content(),
  observedAt: at("observed_at").notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.listingId, t.fingerprint] }),
  kindCheck("listing_versions_kind", t.kind),
  ...deadlineChecks("listing_versions", t),
  check("listing_versions_confirmed_base", sql`${t.confirmedBase} between 0 and 3`),
]);

/** Save/skip state; no row means neutral at revision 0. */
export const listingFeedback = pgTable("listing_feedback", {
  listingId: integer("listing_id").primaryKey().references(() => listings.id, { onDelete: "cascade" }),
  state: text("state", { enum: FEEDBACK_STATES }).notNull(),
  revision: integer("revision").notNull(),
  updatedAt: at("updated_at").notNull().defaultNow(),
}, (t) => [
  check("listing_feedback_state", oneOf(t.state, FEEDBACK_STATES)),
  check("listing_feedback_revision", sql`${t.revision} > 0`),
]);

export const listingFeedbackEvents = pgTable("listing_feedback_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  listingId: integer("listing_id").notNull(),
  revision: integer("revision").notNull(),
  state: text("state", { enum: FEEDBACK_STATES }).notNull(),
  createdAt: at("created_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.listingId], foreignColumns: [listings.id] }).onDelete("cascade"),
  uniqueIndex("listing_feedback_events_listing_revision").on(t.listingId, t.revision),
  check("listing_feedback_events_state", oneOf(t.state, FEEDBACK_STATES)),
  check("listing_feedback_events_revision", sql`${t.revision} > 0`),
]);

/** The one settings row; absent means the defaults at revision 0. */
export const settings = pgTable("settings", {
  id: smallint("id").primaryKey(),
  revision: integer("revision").notNull(),
  maxWeeklyHours: smallint("max_weekly_hours"),
  minFixedTwd: integer("min_fixed_twd").notNull(),
  categories: text("categories").array().notNull(),
}, (t) => [
  check("settings_singleton", sql`${t.id} = 1`),
  check("settings_revision", sql`${t.revision} > 0`),
  check("settings_max_weekly_hours", sql`${t.maxWeeklyHours} between 1 and 168`),
  check("settings_min_fixed_twd", sql`${t.minFixedTwd} between 0 and 10000000`),
  check("settings_categories", sql`cardinality(${t.categories}) > 0 and ${t.categories} <@ array[${sql.raw(CATEGORIES.map((c) => `'${c}'`).join(", "))}]::text[]`),
]);

/** Every mail message a mail source looked at, once (step 7 fills reason codes and dispositions). */
export const mailMessages = pgTable("mail_messages", {
  source: text("source").notNull(),
  recipient: text("recipient").notNull(),
  messageId: text("message_id").notNull(),
  status: text("status", { enum: ["processed", "rejected"] }).notNull(),
  reason: text("reason"),
  disposition: text("disposition", { enum: ["none", "retry", "dismissed"] }).notNull().default("none"),
  checkedAt: at("checked_at").notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.source, t.recipient, t.messageId] }),
  check("mail_messages_status", sql`${t.status} in ('processed', 'rejected')`),
  check("mail_messages_disposition", sql`${t.disposition} in ('none', 'retry', 'dismissed')`),
]);

/** Scan position per mailbox (semantics of mail/sync.ts: cursor, after, head). */
export const mailCursors = pgTable("mail_cursors", {
  source: text("source").notNull(),
  recipient: text("recipient").notNull(),
  cursor: text("cursor"),
  after: text("after"),
  head: text("head"),
}, (t) => [primaryKey({ columns: [t.source, t.recipient] })]);

/** One daily run per Asia/Taipei day. */
export const runs = pgTable("runs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  localDate: date("local_date").notNull().unique(),
  status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull(),
  reason: text("reason"),
  startedAt: at("started_at").notNull().defaultNow(),
  finishedAt: at("finished_at"),
}, (t) => [check("runs_status", sql`${t.status} in ('running', 'succeeded', 'failed')`)]);

/** One row per source per run (step 6 writes it; /sources reads the latest). */
export const runSources = pgTable("run_sources", {
  runId: integer("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  status: text("status", { enum: ["ok", "waiting", "failed"] }).notNull(),
  reason: text("reason"),
  error: text("error"),
  tier: text("tier", { enum: ["plain", "browser_like", "browser"] }).notNull().default("plain"),
  counts: jsonb("counts").notNull().default({}),
  startedAt: at("started_at").notNull().defaultNow(),
  finishedAt: at("finished_at"),
}, (t) => [
  primaryKey({ columns: [t.runId, t.source] }),
  check("run_sources_status", sql`${t.status} in ('ok', 'waiting', 'failed')`),
  check("run_sources_tier", sql`${t.tier} in ('plain', 'browser_like', 'browser')`),
]);

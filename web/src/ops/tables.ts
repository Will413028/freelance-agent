// The tables of backend/src/freelance/platform/schema/001_sqlite.sql that a copy of production
// carries, in load order (parents before the tables that reference them); every table must appear
// exactly once (tested). Used by the one-time import (plan step 4e3) and the digest replay.

/**
 * Who writes a table:
 * - source: intake from external sources.
 * - run: daily run and delivery bookkeeping.
 * - user: written by Will through the UI/API; a change between two copies makes a replay inconclusive.
 * - legacy: historical rows that neither side writes any more.
 */
export type Owner = "source" | "run" | "user" | "legacy";

export type TableSpec = {
  name: string;
  /** Primary key, used to order rows for the lossless fingerprint. */
  pk: string[];
  owner: Owner;
};

const t = (name: string, pk: string[], owner: Owner): TableSpec => ({ name, pk, owner });

export const TABLES: TableSpec[] = [
  t("opportunities", ["id"], "source"),
  t("proposal_revisions", ["opportunity_id", "version"], "legacy"),
  t("source_receipts", ["source", "receipt_id"], "source"),
  t("source_health", ["source"], "run"),
  t("digest_outbox", ["id"], "run"),
  t("daily_runs", ["local_date", "recipient"], "run"),
  t("opportunity_tracking", ["opportunity_id"], "user"),
  t("tracking_events", ["id"], "user"),
  t("ai_draft_attempts", ["opportunity_id", "fingerprint", "priority"], "legacy"),
  t("discovery_settings", ["id"], "user"),
  t("mail_sync_state", ["source", "recipient"], "source"),
  t("mail_ingestion", ["source", "recipient", "message_id"], "source"),
  t("mail_content_versions", ["opportunity_id", "fingerprint"], "source"),
  t("manual_applications", ["id"], "user"),
  t("manual_application_opportunities", ["application_id", "opportunity_id"], "user"),
  t("manual_application_events", ["application_id", "revision"], "user"),
  t("clients", ["id"], "user"),
  t("client_contacts", ["id"], "user"),
  t("application_parties", ["application_id"], "user"),
  t("proposal_templates", ["id"], "user"),
  t("proposal_drafts", ["id"], "user"),
  t("proposal_draft_revisions", ["draft_id", "version"], "user"),
  t("submission_intents", ["id"], "user"),
  t("submission_events", ["intent_id", "revision"], "user"),
  t("application_proposals", ["application_id"], "user"),
];

/**
 * Tables derived from TABLES rows (D15) that Python neither has nor reads: never copied or written
 * back to SQLite; rebuilt from the copy after every load instead. digest_novelty is derived from
 * digest_outbox snapshots; discovery_items and discovery_versions (D16, plan step 10e1) from
 * opportunities, mail_content_versions and discovery_settings. Listed children last, so dropping in
 * reverse order respects foreign keys.
 */
export const DERIVED_TABLES = ["digest_novelty", "discovery_items", "discovery_versions"];

/** D1-only bookkeeping, defined with the lease guard (src/db/d1/guard.ts): never copied, compared, written back or dropped. */
export { D1_ONLY_TABLES as D1_TABLES } from "@/db/d1/guard";

// Table metadata shared by the SQLite → Postgres convergence script (plan step 4c) and the shadow
// comparator (step 4d). Load order respects foreign keys; every table of
// backend/src/freelance/platform/schema/001_sqlite.sql must appear exactly once (tested).

/**
 * Who writes a table, which decides how a one-sided difference is read by the comparator:
 * - source: intake from external sources; one-sided rows can be fetch-time differences.
 * - run: daily run and delivery bookkeeping.
 * - user: written by Will through the Python UI/API; the shadow run never replays these.
 * - legacy: historical rows that neither side writes any more.
 */
export type Owner = "source" | "run" | "user" | "legacy";

export type TableSpec = {
  name: string;
  /** Primary key, used to order rows for the lossless fingerprint. */
  pk: string[];
  /** Key that identifies the same logical row on both sides (differs from pk for generated ids). */
  match: string[];
  /** Columns written from a wall clock or a random id, ignored when comparing the two sides. */
  volatile: string[];
  owner: Owner;
};

const t = (name: string, pk: string[], owner: Owner, volatile: string[] = [], match = pk): TableSpec => ({ name, pk, match, volatile, owner });

export const TABLES: TableSpec[] = [
  t("opportunities", ["id"], "source"),
  t("proposal_revisions", ["opportunity_id", "version"], "legacy", ["created_at"]),
  t("source_receipts", ["source", "receipt_id"], "source", ["received_at"]),
  t("source_health", ["source"], "run", ["checked_at"]),
  t("digest_outbox", ["id"], "run", ["id", "created_at", "attempted_at", "finished_at", "delivery_receipt"], ["local_date", "recipient"]),
  t("daily_runs", ["local_date", "recipient"], "run", ["started_at", "finished_at"]),
  t("opportunity_tracking", ["opportunity_id"], "user"),
  t("tracking_events", ["id"], "user", ["id"], ["opportunity_id", "revision"]),
  t("ai_draft_attempts", ["opportunity_id", "fingerprint", "priority"], "legacy"),
  t("discovery_settings", ["id"], "user"),
  t("mail_sync_state", ["source", "recipient"], "source"),
  t("mail_ingestion", ["source", "recipient", "message_id"], "source", ["checked_at"]),
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

/** Tables with a generated integer id whose sequence must follow the copied rows. */
export const IDENTITY_COLUMNS: Record<string, string> = { tracking_events: "id" };

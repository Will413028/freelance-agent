import { sql } from "drizzle-orm";
import { check, customType, foreignKey, index, integer, pgTable, primaryKey, unique } from "drizzle-orm/pg-core";

// Shape mirrors backend/src/freelance/platform/schema/001_sqlite.sql so the daily copy and the
// reverse script move rows 1:1. Deliberate carry-overs (re-evaluated after the step 13 rollback window):
// - every text column uses COLLATE "C", matching SQLite's BINARY ordering and comparison;
// - JSON stays text: stored bytes feed fingerprints and approval hashes (spike 1c rule 1);
// - timestamps stay text in the format the Python writer produced, so copied rows keep exact values;
// - 0/1 flags stay integer for the same reason.
const text = customType<{ data: string; driverData: string }>({ dataType: () => 'text COLLATE "C"' });

// SQLite CURRENT_TIMESTAMP: UTC, 'YYYY-MM-DD HH:MM:SS'.
export const utcNowText = sql`to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')`;

export const opportunities = pgTable(
  "opportunities",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    item: text("item").notNull(),
  },
  (t) => [unique("opportunities_source_external_id").on(t.source, t.externalId)],
);

export const proposalRevisions = pgTable(
  "proposal_revisions",
  {
    opportunityId: text("opportunity_id").notNull().references(() => opportunities.id),
    version: integer("version").notNull(),
    proposal: text("proposal").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: text("created_at").notNull().default(utcNowText),
  },
  (t) => [primaryKey({ columns: [t.opportunityId, t.version] }), check("proposal_revisions_version", sql`${t.version} > 0`)],
);

export const sourceReceipts = pgTable(
  "source_receipts",
  {
    source: text("source").notNull(),
    receiptId: text("receipt_id").notNull(),
    opportunityId: text("opportunity_id").notNull().references(() => opportunities.id),
    receivedAt: text("received_at").notNull().default(utcNowText),
  },
  (t) => [primaryKey({ columns: [t.source, t.receiptId] })],
);

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

export const digestOutbox = pgTable(
  "digest_outbox",
  {
    id: text("id").primaryKey(),
    localDate: text("local_date").notNull(),
    recipient: text("recipient").notNull(),
    snapshot: text("snapshot").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull().default(utcNowText),
    attemptedAt: text("attempted_at"),
    finishedAt: text("finished_at"),
    deliveryReceipt: text("delivery_receipt"),
  },
  (t) => [
    unique("digest_outbox_local_date_recipient").on(t.localDate, t.recipient),
    check("digest_outbox_status", sql`${t.status} in ('pending', 'attempted', 'sent', 'unknown')`),
    check(
      "digest_outbox_sent_receipt",
      sql`${t.status} <> 'sent' or (${t.deliveryReceipt} is not null and length(trim(${t.deliveryReceipt})) > 0)`,
    ),
  ],
);

export const dailyRuns = pgTable(
  "daily_runs",
  {
    localDate: text("local_date").notNull(),
    recipient: text("recipient").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    result: text("result"),
  },
  (t) => [
    primaryKey({ columns: [t.localDate, t.recipient] }),
    check("daily_runs_status", sql`${t.status} in ('running', 'complete', 'failed')`),
  ],
);

export const opportunityTracking = pgTable("opportunity_tracking", {
  opportunityId: text("opportunity_id").primaryKey().references(() => opportunities.id),
  state: text("state").notNull(),
});

export const trackingEvents = pgTable(
  "tracking_events",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    opportunityId: text("opportunity_id").notNull().references(() => opportunities.id),
    revision: integer("revision").notNull(),
    state: text("state").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [unique("tracking_events_opportunity_revision").on(t.opportunityId, t.revision)],
);

export const aiDraftAttempts = pgTable(
  "ai_draft_attempts",
  {
    opportunityId: text("opportunity_id").notNull().references(() => opportunities.id),
    fingerprint: text("fingerprint").notNull(),
    version: integer("version").notNull(),
    localDate: text("local_date").notNull(),
    recipient: text("recipient").notNull(),
    status: text("status").notNull(),
    attemptedAt: text("attempted_at").notNull(),
    finishedAt: text("finished_at"),
    reason: text("reason"),
    priority: text("priority").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.opportunityId, t.fingerprint, t.priority] }),
    index("ai_draft_attempts_local_date").on(t.localDate),
    check("ai_draft_attempts_version", sql`${t.version} > 0`),
    check("ai_draft_attempts_status", sql`${t.status} in ('attempted', 'succeeded', 'failed', 'stale')`),
    check("ai_draft_attempts_priority", sql`${t.priority} in ('interested', 'prewrite', 'legacy')`),
  ],
);

export const discoverySettings = pgTable(
  "discovery_settings",
  {
    id: integer("id").primaryKey(),
    revision: integer("revision").notNull(),
    settings: text("settings").notNull(),
  },
  (t) => [check("discovery_settings_singleton", sql`${t.id} = 1`)],
);

export const mailSyncState = pgTable(
  "mail_sync_state",
  {
    source: text("source").notNull(),
    recipient: text("recipient").notNull(),
    state: text("state").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.recipient] })],
);

export const mailIngestion = pgTable(
  "mail_ingestion",
  {
    source: text("source").notNull(),
    recipient: text("recipient").notNull(),
    messageId: text("message_id").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    retryPending: integer("retry_pending").notNull().default(0),
    checkedAt: text("checked_at").notNull().default(utcNowText),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.recipient, t.messageId] }),
    check("mail_ingestion_status", sql`${t.status} in ('processed', 'rejected', 'conflict')`),
    check("mail_ingestion_retry_pending", sql`${t.retryPending} in (0, 1)`),
  ],
);

export const mailContentVersions = pgTable(
  "mail_content_versions",
  {
    opportunityId: text("opportunity_id").notNull().references(() => opportunities.id),
    fingerprint: text("fingerprint").notNull(),
    job: text("job").notNull(),
  },
  (t) => [primaryKey({ columns: [t.opportunityId, t.fingerprint] })],
);

export const manualApplications = pgTable(
  "manual_applications",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    contact: text("contact").notNull(),
    url: text("url"),
    appliedOn: text("applied_on").notNull(),
    stage: text("stage").notNull(),
    followUpOn: text("follow_up_on"),
    note: text("note").notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
    requestId: text("request_id").notNull().unique("manual_applications_request_id"),
    requestPayload: text("request_payload").notNull(),
  },
  (t) => [
    check("manual_applications_stage", sql`${t.stage} in ('applied', 'negotiating', 'won', 'closed')`),
    check("manual_applications_revision", sql`${t.revision} > 0`),
  ],
);

export const manualApplicationOpportunities = pgTable(
  "manual_application_opportunities",
  {
    applicationId: text("application_id").notNull().references(() => manualApplications.id),
    opportunityId: text("opportunity_id").notNull().references(() => opportunities.id),
  },
  (t) => [primaryKey({ columns: [t.applicationId, t.opportunityId] }), index("manual_application_links").on(t.opportunityId)],
);

export const manualApplicationEvents = pgTable(
  "manual_application_events",
  {
    applicationId: text("application_id").notNull().references(() => manualApplications.id),
    revision: integer("revision").notNull(),
    action: text("action").notNull(),
    state: text("state").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.applicationId, t.revision] }),
    check("manual_application_events_action", sql`${t.action} in ('created', 'updated', 'deleted')`),
  ],
);

export const clients = pgTable(
  "clients",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    note: text("note").notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
    requestId: text("request_id").notNull().unique("clients_request_id"),
    requestPayload: text("request_payload").notNull(),
  },
  (t) => [check("clients_revision", sql`${t.revision} > 0`)],
);

export const clientContacts = pgTable(
  "client_contacts",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().references(() => clients.id),
    name: text("name").notNull(),
    address: text("address").notNull(),
    note: text("note").notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
    requestId: text("request_id").notNull().unique("client_contacts_request_id"),
    requestPayload: text("request_payload").notNull(),
  },
  (t) => [index("contacts_by_client").on(t.clientId, t.name, t.id), check("client_contacts_revision", sql`${t.revision} > 0`)],
);

export const applicationParties = pgTable(
  "application_parties",
  {
    applicationId: text("application_id").primaryKey().references(() => manualApplications.id),
    clientId: text("client_id").notNull().references(() => clients.id),
    contactId: text("contact_id").references(() => clientContacts.id),
    snapshot: text("snapshot").notNull(),
  },
  (t) => [index("application_parties_by_client").on(t.clientId, t.applicationId)],
);

export const proposalTemplates = pgTable(
  "proposal_templates",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    body: text("body").notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
    requestId: text("request_id").notNull().unique("proposal_templates_request_id"),
    requestPayload: text("request_payload").notNull(),
  },
  (t) => [check("proposal_templates_revision", sql`${t.revision} > 0`)],
);

export const proposalDrafts = pgTable(
  "proposal_drafts",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    revision: integer("revision").notNull(),
    sourceTokens: text("source_tokens").notNull(),
    sourceSnapshot: text("source_snapshot").notNull(),
    party: text("party").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
    requestId: text("request_id").notNull().unique("proposal_drafts_request_id"),
    requestPayload: text("request_payload").notNull(),
  },
  (t) => [check("proposal_drafts_revision", sql`${t.revision} > 0`)],
);

export const proposalDraftRevisions = pgTable(
  "proposal_draft_revisions",
  {
    draftId: text("draft_id").notNull().references(() => proposalDrafts.id),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    valuesJson: text("values_json").notNull(),
    missing: text("missing").notNull(),
    templateSnapshot: text("template_snapshot").notNull(),
    requestId: text("request_id").notNull(),
    requestPayload: text("request_payload").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.draftId, t.version] }),
    unique("proposal_draft_revisions_draft_request").on(t.draftId, t.requestId),
    check("proposal_draft_revisions_version", sql`${t.version} > 0`),
  ],
);

export const submissionIntents = pgTable(
  "submission_intents",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id").notNull().references(() => proposalDrafts.id),
    draftVersion: integer("draft_version").notNull(),
    snapshot: text("snapshot").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    approvalHash: text("approval_hash"),
    status: text("status").notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    attemptedAt: text("attempted_at"),
    finishedAt: text("finished_at"),
    receipt: text("receipt"),
    reconciliation: text("reconciliation"),
    requestId: text("request_id").notNull().unique("submission_intents_request_id"),
    requestPayload: text("request_payload").notNull(),
  },
  (t) => [
    foreignKey({
      name: "submission_intents_draft_version_fk",
      columns: [t.draftId, t.draftVersion],
      foreignColumns: [proposalDraftRevisions.draftId, proposalDraftRevisions.version],
    }),
    check(
      "submission_intents_status",
      sql`${t.status} in ('prepared', 'approved', 'attempted', 'accepted', 'rejected', 'unknown', 'cancelled')`,
    ),
    check("submission_intents_revision", sql`${t.revision} > 0`),
  ],
);

export const submissionEvents = pgTable(
  "submission_events",
  {
    intentId: text("intent_id").notNull().references(() => submissionIntents.id),
    revision: integer("revision").notNull(),
    action: text("action").notNull(),
    evidence: text("evidence").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.intentId, t.revision] })],
);

export const applicationProposals = pgTable(
  "application_proposals",
  {
    applicationId: text("application_id").primaryKey().references(() => manualApplications.id),
    draftId: text("draft_id").notNull(),
    draftVersion: integer("draft_version").notNull(),
    submissionId: text("submission_id").unique("application_proposals_submission_id").references(() => submissionIntents.id),
    snapshot: text("snapshot").notNull(),
  },
  (t) => [
    foreignKey({
      name: "application_proposals_draft_version_fk",
      columns: [t.draftId, t.draftVersion],
      foreignColumns: [proposalDraftRevisions.draftId, proposalDraftRevisions.version],
    }),
  ],
);

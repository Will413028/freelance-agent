// Tables beside the 25 product tables of the frozen SQLite schema (web/tests/fixtures/001_sqlite.sql).

/**
 * Tables derived from product rows (D15): discovery_items and discovery_versions (D16, plan step
 * 10e1), rebuilt from opportunities, mail_content_versions and discovery_settings
 * (scripts/rebuild-projection.ts). Listed children last, so dropping in reverse order respects foreign keys.
 */
export const DERIVED_TABLES = ["discovery_items", "discovery_versions"];

/** D1-only bookkeeping, defined with the lease guard (src/db/d1/guard.ts). */
export { D1_ONLY_TABLES as D1_TABLES } from "@/db/d1/guard";

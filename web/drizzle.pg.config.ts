import { defineConfig } from "drizzle-kit";

// Postgres migrations of the self-hosted rebuild. drizzle-kit only generates them; they are applied
// by scripts/migrate-pg.ts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/pg/schema.ts",
  out: "./drizzle-pg",
});

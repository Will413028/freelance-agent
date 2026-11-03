import { defineConfig } from "drizzle-kit";

// drizzle-kit only generates migrations here. They reach D1 through src/db/migrate.ts alone
// (scripts/migrate.ts): drizzle-kit's own d1-http migrate sends statement by statement and leaves a
// half schema when one fails (plan step 4e2a), so it has no credentials to do that with.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});

import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` needs no credentials. `drizzle-kit migrate` applies the migrations to D1
// over its HTTP API with the same three env values as the app (plan step 4e).
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    databaseId: process.env.D1_DATABASE_ID ?? "",
    token: process.env.D1_API_TOKEN ?? "",
  },
});

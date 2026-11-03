// Apply pending migrations to D1 (plan step 4e3): the step before any deploy whose code needs them
// (Vercel, the VM image). One request behind the writer lease; nothing to do when up to date.
//   CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… pnpm exec tsx scripts/migrate.ts
import { clientOf, getDb } from "../src/db/client";
import { migrateD1 } from "../src/db/migrate";

const db = getDb();
await migrateD1(db);
const [journal] = await clientOf(db).batch([{ sql: "select count(*) from __drizzle_migrations", params: [] }]);
console.log(`migrations applied: ${journal.rows[0][0]}`);

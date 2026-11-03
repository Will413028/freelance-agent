// Rebuild the discovery projection in place on D1 (plan step 10e1): once after the migration that
// creates discovery_items and discovery_versions (they start empty while opportunities do not), and
// whenever the derivation changes. Run it after scripts/migrate.ts and before deploying code that
// reads the projection; it waits for and holds the writer lease, outside 09:00–09:59 Asia/Taipei.
//   CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… pnpm exec tsx scripts/rebuild-projection.ts
import { clientOf, getDb } from "../src/db/client";
import { rebuildProjectionInPlace } from "../src/services/discovery";

const db = getDb();
const rows = await rebuildProjectionInPlace(db);
console.log(`projection rows: ${rows}`);
console.log(`d1_rows_written\t${clientOf(db).counters.rowsWritten}`);

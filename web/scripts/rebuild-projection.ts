// Rebuild the discovery projection in place on D1 (plan step 10e1): once after the code that
// maintains it is deployed (Vercel and the VM image), because records written by older code have no
// projection rows, and again whenever the derivation changes. Order: scripts/migrate.ts, deploy,
// then this. It holds the writer lease for the whole read, delete and reload, so it refuses to run
// during the daily run (09:00–09:59 Asia/Taipei). A failure partway leaves the projection partial,
// which every read refuses (checkState); run it again.
//   CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… pnpm exec tsx scripts/rebuild-projection.ts
import { clientOf, getDb, readAll } from "../src/db/client";
import { checkState, projectionStateRead } from "../src/modules/discovery/public";
import { rebuildProjectionInPlace } from "../src/services/discovery";

const taipeiHour = (new Date().getUTCHours() + 8) % 24;
if (taipeiHour === 9) throw new Error("refusing to rebuild during the daily run (09:00–09:59 Asia/Taipei)");
const db = getDb();
const rows = await rebuildProjectionInPlace(db);
const [state] = await readAll(db, [projectionStateRead(db)]);
console.log(`projection rows: ${rows}; ${JSON.stringify(state)}`);
console.log(`d1_rows_written\t${clientOf(db).counters.rowsWritten}`);
checkState(state);
console.log("projection ok");

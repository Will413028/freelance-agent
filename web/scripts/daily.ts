// The daily run (plan step 6), started by the VM's systemd timer through `docker compose run --rm daily`.
// It takes a session advisory lock on its one connection first: a second start while one runs exits, and a
// run killed midway releases the lock with its connection, so the next start resumes that day. It prints
// the outcome (date, status, source names) only. Exit code 1 when the run failed.
//   DATABASE_URL=… pnpm exec tsx scripts/daily.ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { schema } from "../src/db/pg/client";
import { runDaily } from "../src/services/run-daily";

/** Any fixed 64-bit key; only this script takes it. */
const LOCK_KEY = 6_020_611;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must be set");
const client = new Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [LOCK_KEY]);
  if (!rows[0]?.locked) {
    console.log(JSON.stringify({ outcome: "busy" }));
  } else {
    const result = await runDaily(drizzle(client, { schema }), { now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    console.log(JSON.stringify(result));
    if (result.outcome === "failed") process.exitCode = 1;
  }
} finally {
  await client.end();
}

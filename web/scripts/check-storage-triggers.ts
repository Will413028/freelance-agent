// The D20/D21 revocation triggers over the daily runs from --since on (default: yesterday, UTC), on
// D1. Prints dates, signal names and numbers only; exit 1 when any decision is reopened, so the
// after job's report shows it (wired in plan step 4e3).
//   CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… pnpm exec tsx scripts/check-storage-triggers.ts [--since YYYY-MM-DD]
import { parseArgs } from "node:util";
import { getDb } from "../src/db/client";
import { storageSignals } from "../src/ops/storage-triggers";

const { values } = parseArgs({ options: { since: { type: "string" } } });
const since = values.since ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const { runs, signals } = await storageSignals(getDb(), since);
for (const s of signals) console.log(`${s.localDate} ${s.decision} ${s.signal} ${s.value}`);
const reopened = signals.filter((s) => s.decision !== "totals");
console.log(`storage triggers since ${since}: ${runs} runs, ${reopened.length} signals${reopened.length ? " — revisit " + [...new Set(reopened.map((s) => s.decision))].join(", ") : ""}`);
process.exitCode = reopened.length ? 1 : 0;

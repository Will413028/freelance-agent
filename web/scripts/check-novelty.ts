// Rederive the digest_novelty ledger from the stored snapshots and compare (plan step 10b2, D15), with
// read-only queries on D1. No digest since the day fails: the day's TS run should have built one.
//   CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… pnpm exec tsx scripts/check-novelty.ts --since YYYY-MM-DD
import { parseArgs } from "node:util";
import { getDb } from "../src/db/client";
import { checkLedger } from "../src/services/digest";

const { values } = parseArgs({ options: { since: { type: "string" } } });
if (!values.since) throw new Error("usage: check-novelty.ts --since YYYY-MM-DD");
const check = await checkLedger(getDb(), values.since);
console.log(check.digests === 0 ? `novelty ledger: NO DIGEST since ${values.since}`
  : `novelty ledger ${check.ok ? "same" : "DIFFERENT"}: ${check.digests} digests, ${check.rows} rows, ${check.missing} missing, ${check.extra} extra`);
process.exitCode = check.ok ? 0 : 1;

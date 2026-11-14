// Walking skeleton only (plan step 2); removed in step 3.
import { getPgDb } from "../src/db/pg/client";
import { seedSkeleton } from "../src/db/pg/listings";

await seedSkeleton(getPgDb());
console.log("skeleton listing present");
process.exit(0);

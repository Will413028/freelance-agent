import { getPgDb } from "@/db/pg/client";
import { latestListings } from "@/db/pg/listings";
import { SkeletonList } from "../_lib/skeleton";

export const dynamic = "force-dynamic";

/** Walking skeleton (plan step 2): proves the VM path web → Postgres. Removed in step 3. */
export default async function Page() {
  return <SkeletonList listings={await latestListings(getPgDb())} />;
}

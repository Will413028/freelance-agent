import { getPgDb } from "@/db/pg/client";
import { health } from "../_lib/health";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return health(getPgDb);
}

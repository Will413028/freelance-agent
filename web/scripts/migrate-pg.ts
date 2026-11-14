import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { migratePg } from "../src/db/pg/migrate";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: url, max: 1 });
try {
  await migratePg(drizzle(pool));
  console.log("migrations applied");
} finally {
  await pool.end();
}

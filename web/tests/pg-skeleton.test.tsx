import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { latestListings, seedSkeleton, SKELETON_LISTING } from "@/services/skeleton";
import { SkeletonList } from "@/app/_lib/skeleton";
import { health } from "@/app/_lib/health";
import { freshPg } from "./helpers/pg";

// Plan step 2: the walking skeleton's path on Postgres (PGlite here, a real server in CI).

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());

describe("walking skeleton", () => {
  it("migrations create the skeleton tables", async () => {
    // node-postgres and PGlite both return { rows }.
    const { rows } = (await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`)) as unknown as { rows: { table_name: string }[] };
    expect(rows.map((r) => r.table_name)).toEqual(["listings", "runs"]);
  });

  it("seeding twice leaves one listing, and the page shows it", async () => {
    await seedSkeleton(db);
    await seedSkeleton(db);
    const listings = await latestListings(db);
    expect(listings).toEqual([{ id: SKELETON_LISTING.id, source: "skeleton", title: SKELETON_LISTING.title, url: SKELETON_LISTING.url }]);
    expect(renderToStaticMarkup(<SkeletonList listings={listings} />)).toContain(SKELETON_LISTING.title);
  });

  it("runs refuses a status outside running, succeeded, failed", async () => {
    await expect(db.execute(sql`insert into runs (local_date, status) values ('2026-11-17', 'done')`)).rejects.toThrow();
  });

  it("runs allows one row per day", async () => {
    await db.execute(sql`insert into runs (local_date, status) values ('2026-11-16', 'running')`);
    await expect(db.execute(sql`insert into runs (local_date, status) values ('2026-11-16', 'running')`)).rejects.toThrow();
  });

  it("healthz is 200 when Postgres answers and 503 when it does not", async () => {
    expect((await health(() => db)).status).toBe(200);
    const broken = { execute: () => Promise.reject(new Error("connection refused")) } as unknown as PgDb;
    const res = await health(() => broken);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });
});

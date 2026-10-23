import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, resetSchema } from "../../../tests/helpers/db";
import { applicationProjections } from "./projections";

// Inventory defect 11: the HP7 application token follows SQLite's BINARY order of application ids.
// "B1" sorts before "a1" in BINARY/C but after it under ICU or glibc en_US collations.
beforeEach(resetSchema);
afterAll(async () => { await pool.end(); });

describe("application projections", () => {
  it("orders tokens like SQLite BINARY and lists only live application ids", async () => {
    await pool.query("insert into opportunities values ('o1','guru','1','{}')");
    for (const [id, deleted] of [["a1", null], ["B1", "2026-10-01"]]) {
      await pool.query("insert into manual_applications values ($1,'t','c',null,'2026-10-01','applied',null,'',2,'c','u',$2,$1,'{}')", [id, deleted]);
      await pool.query("insert into manual_application_opportunities values ($1,'o1')", [id]);
    }
    expect((await pool.query("select 'B1' < 'a1' collate \"und-x-icu\" as icu")).rows[0].icu).toBe(false);
    expect((await applicationProjections(db)).get("o1")).toEqual({ ids: ["a1"], token: ["B1:2:2026-10-01", "a1:2:"] });
  });
});

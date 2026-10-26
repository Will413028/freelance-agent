import { beforeEach, describe, expect, it } from "vitest";
import { readAll } from "@/db/client";
import { db, query, resetSchema } from "../../../tests/helpers/db";
import { applicationProjectionsRead } from "./projections";

// Inventory defect 11: the HP7 application token follows SQLite's BINARY order of application ids.
// "B1" sorts before "a1" in BINARY but after it under ICU or glibc en_US collations.
beforeEach(resetSchema);

describe("application projections", () => {
  it("orders tokens like SQLite BINARY and lists only live application ids", async () => {
    await query("insert into opportunities values ('o1','guru','1','{}')");
    for (const [id, deleted] of [["a1", null], ["B1", "2026-10-01"]]) {
      await query("insert into manual_applications values (?1,'t','c',null,'2026-10-01','applied',null,'',2,'c','u',?2,?1,'{}')", [id, deleted]);
      await query("insert into manual_application_opportunities values (?,'o1')", [id]);
    }
    const [projections] = await readAll(db, [applicationProjectionsRead(db)]);
    expect(projections.get("o1")).toEqual({ ids: ["a1"], token: ["B1:2:2026-10-01", "a1:2:"] });
  });
});

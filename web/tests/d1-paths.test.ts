import { beforeEach, describe, expect, it } from "vitest";
import { claimDailyRun, getDailyRun } from "@/modules/notifications/public";
import { PyDateTime } from "@/platform/py/datetime";
import { list } from "./helpers/reference";
import { client, db, losingResponse, resetSchema } from "./helpers/db";

// Plan step 4e2a: reads and single statements on D1. No transactions exist, so what used to be a
// read transaction is one batch, and a lost response is answered by the statement's own semantics.
// The digest's paths were removed with the digest (plan step 10f, D22).
const at = (h: number) => new PyDateTime(2026, 10, 24, h, 0, 0, 0, 0n);
const EMAIL = "owner@example.invalid";

beforeEach(resetSchema);

describe("reads on D1", () => {
  it("reads a list in two requests: the ranking over the projection, then the ranked rows (plan step 10e2)", async () => {
    const before = client.counters.requests;
    await list(db, at(1));
    expect(client.counters.requests - before).toBe(2);
  });
});

describe("single statements after a lost response", () => {
  it("recognizes its own daily claim when the response was lost after commit", async () => {
    const lossy = losingResponse((sql) => sql[0].startsWith("insert into \"daily_runs\""));
    expect(await claimDailyRun(lossy.db, "2026-10-24", EMAIL, at(1))).toBe(true);
    expect(lossy.fired()).toBe(true);
    expect(await claimDailyRun(db, "2026-10-24", EMAIL, at(2))).toBe(false);
    expect((await getDailyRun(db, "2026-10-24", EMAIL))!.startedAt).toBe(at(1).isoformat());
  });
});

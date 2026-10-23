import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { writeTransaction } from "@/db/client";
import { PyDateTime } from "@/platform/py/datetime";
import { PyDict } from "@/platform/py/value";
import { db, pool, resetSchema } from "../../../tests/helpers/db";
import { job } from "../../../tests/helpers/jobs";
import { feedbackChanged, getRecord, insertRecord, newObservation, saveRecord } from "./records";

const now = new PyDateTime(2026, 9, 28, 1, 0, 0, 0, 0n);
const evaluation = PyDict.of({ status: "qualified" });

beforeEach(resetSchema);
afterAll(async () => { await pool.end(); });

describe("legacy envelope codec", () => {
  it("keeps a skip across a new observation and bumps the version", () => {
    const old = newObservation("k", job(), "f1", evaluation, null);
    old.update({ review_status: "skipped", skip_reason: "scope" });
    const next = newObservation("k", job(), "f2", evaluation, old);
    expect([next.req("version"), next.req("review_status"), next.req("skip_reason"), next.req("proposal")]).toEqual([2n, "skipped", "scope", ""]);
  });

  it("re-opens a skipped envelope on interest and drops an approval on skip", async () => {
    await writeTransaction(db, async (tx) => {
      const item = newObservation("k", job(), "f1", evaluation, null);
      await insertRecord(tx, item);
      item.update({ review_status: "skipped", skip_reason: "scope" });
      const reopened = await feedbackChanged(tx, item, "interested", now);
      expect([reopened.req("review_status"), reopened.req("skip_reason"), reopened.req("version")]).toEqual(["draft", "", 2n]);
      reopened.update({ review_status: "approved", approved_hash: "h" });
      const skipped = await feedbackChanged(tx, reopened, "skipped", now);
      expect([skipped.req("review_status"), skipped.req("approved_hash"), skipped.req("version")]).toEqual(["draft", null, 3n]);
      expect((await getRecord(tx, "k"))!.req("version")).toBe(3n);
    });
  });

  it("writes a proposal revision only for envelopes that carry proposal text", async () => {
    await writeTransaction(db, async (tx) => {
      const item = newObservation("k", job(), "f1", evaluation, null);
      await insertRecord(tx, item);
      await saveRecord(tx, item);
      item.set("proposal", "舊提案");
      await saveRecord(tx, item);
      await saveRecord(tx, item); // same version: ON CONFLICT DO NOTHING keeps the first text
    });
    const { rows } = await pool.query("select opportunity_id, version, proposal from proposal_revisions");
    expect(rows).toEqual([{ opportunity_id: "k", version: 1, proposal: "舊提案" }]);
  });
});

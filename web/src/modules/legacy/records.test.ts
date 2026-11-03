import { beforeEach, describe, expect, it } from "vitest";
import { DAILY_WRITE, writeUnit, type Writes } from "@/db/unit";
import { PyDateTime } from "@/platform/py/datetime";
import { PyDict } from "@/platform/py/value";
import { defaults, preferences } from "@/modules/discovery/public";
import { db, query, resetSchema } from "../../../tests/helpers/db";
import { job } from "../../../tests/helpers/jobs";
import { allRecords, feedbackChanged, newObservation, Records, recordsRead } from "./records";

const now = new PyDateTime(2026, 9, 28, 1, 0, 0, 0, 0n);
const evaluation = PyDict.of({ status: "qualified" });
const settings = preferences(defaults());

/** fn over the records with these ids, in one write unit. */
const inUnit = <T>(keys: string[], fn: (records: Records, writes: Writes) => T) =>
  writeUnit(db, DAILY_WRITE, [recordsRead(db, keys)], ([found], writes) => fn(new Records(found, writes), writes) as never);

beforeEach(resetSchema);

describe("legacy envelope codec", () => {
  it("keeps a skip across a new observation and bumps the version", () => {
    const old = newObservation("k", job(), "f1", evaluation, null);
    old.update({ review_status: "skipped", skip_reason: "scope" });
    const next = newObservation("k", job(), "f2", evaluation, old);
    expect([next.req("version"), next.req("review_status"), next.req("skip_reason"), next.req("proposal")]).toEqual([2n, "skipped", "scope", ""]);
  });

  it("re-opens a skipped envelope on interest and drops an approval on skip", async () => {
    await inUnit(["k"], (records) => records.insert(newObservation("k", job(), "f1", evaluation, null)));
    await inUnit(["k"], (records) => {
      const item = records.get("k")!;
      item.update({ review_status: "skipped", skip_reason: "scope" });
      const reopened = feedbackChanged(records, settings, item, "interested", now);
      expect([reopened.req("review_status"), reopened.req("skip_reason"), reopened.req("version")]).toEqual(["draft", "", 2n]);
      reopened.update({ review_status: "approved", approved_hash: "h" });
      const skipped = feedbackChanged(records, settings, reopened, "skipped", now);
      expect([skipped.req("review_status"), skipped.req("approved_hash"), skipped.req("version")]).toEqual(["draft", null, 3n]);
      // A later get in the same unit sees the saved envelope.
      expect(records.get("k")!.req("version")).toBe(3n);
    });
    expect((await allRecords(db))[0].req("version")).toBe(3n);
  });

  it("returns copies: changing a got record without saving it changes nothing", async () => {
    await inUnit(["k"], (records) => records.insert(newObservation("k", job(), "f1", evaluation, null)));
    await inUnit(["k"], (records) => {
      records.get("k")!.set("version", 9n);
      expect(records.get("k")!.req("version")).toBe(1n);
    });
  });

  it("writes a proposal revision only for envelopes that carry proposal text", async () => {
    await inUnit(["k"], (records) => {
      const item = newObservation("k", job(), "f1", evaluation, null);
      records.insert(item);
      records.save(item);
      item.set("proposal", "舊提案");
      records.save(item);
      item.set("proposal", "新提案");
      records.save(item); // same version: ON CONFLICT DO NOTHING keeps the first text
    });
    const rows = await query("select opportunity_id, version, proposal from proposal_revisions");
    expect(rows).toEqual([{ opportunity_id: "k", version: 1, proposal: "舊提案" }]);
  });

  it("refuses a record the unit did not read", async () => {
    await expect(inUnit(["k"], (records) => records.get("other"))).rejects.toThrow("was not read by this unit");
  });
});

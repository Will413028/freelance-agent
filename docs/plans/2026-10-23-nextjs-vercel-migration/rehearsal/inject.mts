// Step 12 rehearsal (plan): the fixed set of changes TS makes after a cutover, applied to a test D1
// just loaded from a production copy. A fixed `now` and fixed choices make both rehearsals identical.
// Mounted into the shadow image as /app/web/scripts/rehearsal-inject.mts; prints counts and keys only.
//   ... run --entrypoint pnpm shadow exec tsx scripts/rehearsal-inject.mts --confirm <database id> --expected <file>
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { clientOf, getDb } from "../src/db/client";
import { ingestSource, mailState, saveMailState } from "../src/modules/collection/public";
import { readSettings } from "../src/modules/discovery/public";
import { claimDailyRun, finishDailyRun } from "../src/modules/notifications/public";
import { PyDateTime } from "../src/platform/py/datetime";
import { py, PyDict } from "../src/platform/py/value";
import { feedback, group, memberVersions, replaceSettings } from "../src/services/discovery";

const { values } = parseArgs({ options: { confirm: { type: "string" }, expected: { type: "string" } } });
if (!values.confirm || values.confirm !== process.env.D1_DATABASE_ID || !values.expected) {
  throw new Error("usage: rehearsal-inject.mts --confirm <D1_DATABASE_ID> --expected <file>; it writes to that database");
}
const db = getDb(), now = new PyDateTime(2026, 11, 30, 1, 0, 0, 0, 0n);
const one = async (sql: string) => (await clientOf(db).batch([{ sql, params: [] }]))[0].rows;

// 1. A new listing from a stand-in source (no network).
const job = py({
  source: "tasker", external_id: "rehearsal-1", title: "Rehearsal listing", description: "Synthetic listing for the step 12 rehearsal.",
  url: "https://example.invalid/rehearsal-1", kind: "fixed", currency: "TWD", budget_min: 4000n, budget_max: 8000n, weekly_hours: 10n,
  taiwan_eligible: true, timezone_compatible: true, deadline: "2099-01-01", language: "en", complete: true,
}) as PyDict;
const [created] = await ingestSource(db, "tasker", now, [[job, null]], () => true, "ok");
// 2. Feedback on the first listing that has none.
const [[target]] = await one("select o.id from opportunities o left join opportunity_tracking t on t.opportunity_id = o.id where t.state is null order by o.id limit 1");
await feedback(db, String(target), memberVersions(await group(db, String(target), now)), "interested", now);
// 3. A settings change: the weekly hours limit toggles.
const before = await readSettings(db);
const hours = before.settings.at("max_weekly_hours") === null ? 25n : null;
const after = await replaceSettings(db, before.revision, new PyDict(before.settings).update({ max_weekly_hours: hours }));
// 4. A finished daily run under the recipient Python uses.
const [[recipient]] = await one("select recipient from daily_runs order by local_date desc limit 1");
const day = "2026-11-30";
if (!(await claimDailyRun(db, day, String(recipient), now))) throw new Error("the rehearsal day already has a run");
await finishDailyRun(db, day, String(recipient), "complete", PyDict.of({ status: "collected", local_date: day }), now);
// 5. A mail cursor moved forward.
const [[mailSource, mailRecipient]] = await one("select source, recipient from mail_sync_state order by source, recipient limit 1");
const state = await mailState(db, String(mailSource), String(mailRecipient));
await saveMailState(db, String(mailSource), String(mailRecipient), new PyDict(state).update({ cursor: "rehearsal-cursor" }));

const [[opportunities]] = await one("select count(*) from opportunities");
const feedbackCounts = Object.fromEntries((await one("select json_extract(state, '$.feedback') f, count(*) from opportunity_tracking group by f order by f"))
  .map(([f, n]) => [String(f), Number(n)]));
const expected = {
  opportunities: Number(opportunities), new_listing: created.str("id"), feedback_target: String(target), feedback_counts: feedbackCounts,
  settings_revision: Number(after.revision), day, mail: { source: String(mailSource), cursor: "rehearsal-cursor" },
};
writeFileSync(values.expected, JSON.stringify(expected, null, 1) + "\n", { mode: 0o600 });
console.log(`injected: 1 listing, 1 feedback, settings revision ${expected.settings_revision}, daily run ${day}, 1 mail cursor; opportunities ${expected.opportunities}`);

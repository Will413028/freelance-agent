// Writes cases.json from golden.json's jobbank104_parse (40 digests the Python parser read; run once,
// golden.json is deleted in plan step 11):  pnpm exec tsx src/modules/sources/mail/jobbank104/fixtures/generate.ts
// The expected listings come from the OLD result, mapped field by field to the listing contract, so
// they are independent of the new parser. Old refusals expect a rejection; its reason code is the new
// parser's (the old raised one MailParseError class for every check). Every case where the new parser
// deliberately differs from the old result is listed in DIFFERENCES with its reason; cases.json is never
// edited by hand.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseListingInput, type ListingInput } from "@/modules/listings/public";
import { MailRejection } from "../../reasons";
import { parse104 } from "..";

type Old = { message: { sender: string; subject: string; body: string; is_html: boolean }; expect: { ok: string } | { error: string } };
const golden: Old[] = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../../../../tests/fixtures/golden.json"), "utf8")).jobbank104_parse;

/** case index → why the new expectation differs from the old result. */
const DIFFERENCES: Record<number, { kind: "ENVELOPE" | "ACCEPTED" | "REFUSED"; why: string }> = {
  4: { kind: "ENVELOPE", why: "received_at without a time is checked by readMessage (bad_received_at, message.test.ts), not by the parser" },
  32: { kind: "ACCEPTED", why: "an unclosed link at the very end is closed by the HTML parser; the card count still guards a cut-off digest" },
  34: { kind: "REFUSED", why: "a fullwidth digit in the subject count: JavaScript \\d is ASCII; 104 writes ASCII digits" },
};

const fromOld = (j: Record<string, unknown>): ListingInput => parseListingInput({
  external_id: j.external_id, title: j.title, company: j.company, url: j.url, canonical_url: j.canonical_url,
  description: j.description, kind: j.kind, complete: j.complete, taiwan_eligible: j.taiwan_eligible,
  timezone_compatible: j.timezone_compatible, weekly_hours: j.weekly_hours, currency: j.currency,
  budget_min: j.budget_min, budget_max: j.budget_max, deadline: j.deadline, published_at: j.published_at,
});

type Expected = { listings: ListingInput[] } | { reason: string };
const run = (m: Old["message"]): Expected => {
  try {
    return { listings: parse104({ id: "x", sender: m.sender.toLowerCase(), subject: m.subject, body: m.body, isHtml: m.is_html, receivedAt: "2026-09-26T03:00:00.000Z" }) };
  } catch (e) {
    if (e instanceof MailRejection) return { reason: e.reason };
    throw e;
  }
};

const unexplained: string[] = [];
const cases = golden.map((g, i) => {
  const got = run(g.message);
  const old: Expected | null = "ok" in g.expect ? { listings: (JSON.parse(g.expect.ok) as Record<string, unknown>[]).map(fromOld) } : null;
  const agree = old === null ? "reason" in got : JSON.stringify(old) === JSON.stringify(got);
  const diff = DIFFERENCES[i];
  if (agree === Boolean(diff)) unexplained.push(`case ${i}: old ${JSON.stringify(g.expect).slice(0, 120)} new ${JSON.stringify(got).slice(0, 200)}`);
  const message = { sender: g.message.sender, subject: g.message.subject, body: g.message.body, isHtml: g.message.is_html };
  return { name: `golden ${i}${diff ? ` (${diff.kind}: ${diff.why})` : ""}`, message, expect: diff || old === null ? got : old };
});
if (unexplained.length) {
  console.error(unexplained.join("\n"));
  process.exit(1);
}
writeFileSync(path.join(import.meta.dirname, "cases.json"), JSON.stringify(cases, null, 1) + "\n");
console.log(`${cases.length} cases written`);

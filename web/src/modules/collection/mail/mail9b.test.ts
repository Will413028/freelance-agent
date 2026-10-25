import { describe, expect, it } from "vitest";
import { htmlFeed } from "@/platform/py/html";
import { encode } from "@/platform/py/json";
import { asDict } from "@/platform/py/value";
import { attempt, attemptAsync, fixture, untag, type Expect, type Tagged } from "../../../../tests/helpers/golden";
import { transport } from "../../../../tests/helpers/resend";
import { canonical as cakeCanonical, parseCake } from "./cake";
import { canonical as glassdoorCanonical, parseGlassdoor } from "./glassdoor";
import { parse104 } from "./jobbank104";
import type { MailMessage } from "./message";
import { matches, NotificationError, readNotification, ReceivingClient } from "./receiving";
import { canonical as talentCanonical, parseTalent } from "./talent";

// Plan step 9b: cake_mail.py, jobbank104_mail.py, talent_mail.py and glassdoor_mail.py, plus the
// html.parser comment behaviour they rely on (query decoding is checked through the canonical cases), against gen_golden.py's
// ground truth (production image Python 3.13.15). Parser failures are compared as failures.

type Message = { message_id: string; sender: string; subject: string; body: string; is_html: boolean; received_at: string };
type Pages = Record<string, [number, string]>;
type Event = ["start", string, [string, string | null][]] | ["end", string] | ["data", string] | ["comment", string];
const golden = fixture<{
  html_events: { input: string; close: boolean; expect: Event[] }[];
  cake_canonical: { input: Tagged; expect: Expect<string> }[];
  talent_canonical: { input: Tagged; expect: Expect<string[]> }[];
  glassdoor_canonical: { input: Tagged; expect: Expect<string[]> }[];
  cake_parse: { message: Message; expect: Expect<string> }[];
  jobbank104_parse: { message: Message; expect: Expect<string> }[];
  talent_parse: { message: Message; expect: Expect<string> }[];
  glassdoor_parse: { message: Message; expect: Expect<string> }[];
  resend_matches_9b: { entry: Tagged; source: string; expect: boolean }[];
  read_notification_9b: { source: string; retry: boolean; pages: Pages; expect: Expect<{ jobs: string } | { stage: string }>; calls: string[] }[];
}>("golden.json");

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const failed = <T,>(e: Expect<T>) => ("error" in e ? { error: true } : e);
const message = (m: Message): MailMessage => ({ messageId: m.message_id, sender: m.sender, subject: m.subject, body: m.body, isHtml: m.is_html, receivedAt: m.received_at });
const str = (t: Tagged) => untag(t) as string | null;

describe("html.parser comments", () => {
  it("reports tags, data and comments in Python's order, with and without close()", () => {
    const bad = golden.html_events.filter((c) => {
      const events: Event[] = [];
      htmlFeed(c.input, {
        starttag: (tag, attrs) => events.push(["start", tag, attrs]), endtag: (tag) => events.push(["end", tag]),
        data: (d) => events.push(["data", d]), comment: (d) => events.push(["comment", d]),
      }, c.close);
      return !same(events, c.expect);
    });
    expect(bad.map((c) => [c.input, c.close])).toEqual([]);
  });
});

describe("job link canonicalisation", () => {
  it.each([["cake", golden.cake_canonical, cakeCanonical], ["talent", golden.talent_canonical, talentCanonical], ["glassdoor", golden.glassdoor_canonical, glassdoorCanonical]] as const)(
    "%s", (_name, cases, fn) => {
      const bad = (cases as { input: Tagged; expect: Expect<unknown> }[]).filter((c) => !same(failed(attempt(() => (fn as (v: string | null) => unknown)(str(c.input)))), failed(c.expect)));
      expect(bad.map((c) => c.input)).toEqual([]);
    });
});

describe("parsers", () => {
  it.each([["cake", golden.cake_parse, parseCake], ["jobbank104", golden.jobbank104_parse, parse104], ["talent", golden.talent_parse, parseTalent],
    ["glassdoor", golden.glassdoor_parse, parseGlassdoor]] as const)("%s output matches Python byte for byte", (_name, cases, parse) => {
    const bad = cases.map((c) => ({ c, got: attempt(() => encode(parse(message(c.message)))) })).filter(({ c, got }) => !same(failed(got), failed(c.expect)));
    expect(bad.map(({ c, got }) => ({ body: c.message.body.slice(0, 120), subject: c.message.subject, got, want: c.expect }))).toEqual([]);
    expect(cases.filter((c) => "ok" in c.expect).length).toBeGreaterThan(4);
  });
  it("rejects bodies past 1 MB", () => {
    for (const [cases, parse] of [[golden.cake_parse, parseCake], [golden.jobbank104_parse, parse104], [golden.talent_parse, parseTalent], [golden.glassdoor_parse, parseGlassdoor]] as const) {
      const m = message(cases[0].message);
      expect(() => parse({ ...m, body: m.body + "x".repeat(1_000_001) })).toThrow("");
    }
  });
});

describe("receiving for the 9b sources", () => {
  it("gates talent and glassdoor subjects", () => {
    const bad = golden.resend_matches_9b.filter((c) => matches(asDict(untag(c.entry)), c.source) !== c.expect);
    expect(bad.map((c) => [c.entry, c.source])).toEqual([]);
  });
  it("reads and checks each envelope as Python does", async () => {
    const bad = [];
    for (const c of golden.read_notification_9b) {
      const calls: string[] = [];
      const client = new ReceivingClient("re_synthetic", { request: transport(c.pages, calls), pause: async () => {}, sources: [c.source] });
      const got = await attemptAsync(async () => {
        await client.listReceived();
        try {
          return { jobs: encode(await readNotification(client, "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", "test@inbox.resend.app", c.source)) };
        } catch (e) {
          if (e instanceof NotificationError) return { stage: e.stage };
          throw e;
        }
      });
      if (!same(failed(got), failed(c.expect)) || !same(calls, c.calls)) bad.push({ source: c.source, got, want: c.expect });
    }
    expect(bad).toEqual([]);
  });
});


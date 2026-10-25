import { describe, expect, it } from "vitest";
import { getaddresses } from "@/platform/py/email";
import { encode } from "@/platform/py/json";
import { asDict, PyError } from "@/platform/py/value";
import { attempt, attemptAsync, fixture, untag, type Expect, type Tagged } from "../../../../tests/helpers/golden";
import { transport } from "../../../../tests/helpers/resend";
import { parseLinkedin } from "./linkedin";
import type { MailMessage } from "./message";
import { MAX_BYTES, matches, NotificationError, readNotification, ReceivingClient, resendId, sender } from "./receiving";
import { parseTasker } from "./tasker";

// Plan step 9a: email.utils.getaddresses, resend_preview's identifiers, sender allowlist, subject gates
// and read_notification, and the Tasker and LinkedIn parsers, against the ground truth gen_golden.py
// wrote with the production image's Python (3.13.15). Parser errors all become one rejected message
// (stage 'template'), so they are compared as failures; read_notification is compared by stage.

type Pages = Record<string, [number, string]>;
type Message = { message_id: string; sender: string; subject: string; body: string; is_html: boolean; received_at: string };
const golden = fixture<{
  getaddresses: { input: string; expect: [string, string][] }[];
  resend_id: { input: Tagged; expect: Expect<string> }[];
  resend_sender: { input: Tagged; expect: string | null }[];
  resend_matches: { entry: Tagged; source: string; expect: boolean }[];
  tasker_parse: { message: Message; expect: Expect<string> }[];
  linkedin_parse: { message: Message; expect: Expect<string> }[];
  read_notification: { source: string; retry: boolean; pages: Pages; expect: Expect<{ jobs: string } | { stage: string }>; calls: string[] }[];
}>("golden.json");

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const failed = <T,>(e: Expect<T>) => ("error" in e ? { error: true } : e);
const message = (m: Message): MailMessage => ({ messageId: m.message_id, sender: m.sender, subject: m.subject, body: m.body, isHtml: m.is_html, receivedAt: m.received_at });

describe("email.utils.getaddresses (strict)", () => {
  it("parses every header value as CPython 3.13.15 does", () => {
    const bad = golden.getaddresses.filter((c) => !same(getaddresses([c.input]), c.expect));
    expect(bad.map((c) => c.input)).toEqual([]);
  });
});

describe("resend identifiers, senders and subject gates", () => {
  it("accepts only the canonical lowercase UUID form", () => {
    const bad = golden.resend_id.filter((c) => !same(failed(attempt(() => resendId(untag(c.input)))), failed(c.expect)));
    expect(bad.map((c) => c.input)).toEqual([]);
  });
  it("reads the sender as _sender does", () => {
    const bad = golden.resend_sender.filter((c) => sender(untag(c.input)) !== c.expect);
    expect(bad.map((c) => c.input)).toEqual([]);
  });
  it("gates sender and subject per source", () => {
    const bad = golden.resend_matches.filter((c) => matches(asDict(untag(c.entry)), c.source) !== c.expect);
    expect(bad.map((c) => [c.entry, c.source])).toEqual([]);
  });
});

describe("tasker and linkedin parsers", () => {
  it.each([["tasker", parseTasker], ["linkedin", parseLinkedin]] as const)("%s output matches Python byte for byte", (name, parse) => {
    const cases = name === "tasker" ? golden.tasker_parse : golden.linkedin_parse;
    const bad = cases.map((c) => ({ c, got: attempt(() => encode(parse(message(c.message)))) })).filter(({ c, got }) => !same(failed(got), failed(c.expect)));
    expect(bad.map(({ c, got }) => ({ body: c.message.body.slice(0, 80), got, want: c.expect }))).toEqual([]);
    expect(cases.filter((c) => "ok" in c.expect).length).toBeGreaterThan(10);
  });
  it("rejects bodies past the size limits", () => {
    const li = golden.linkedin_parse[0].message;
    expect(() => parseLinkedin(message({ ...li, body: "x".repeat(1_000_001) }))).toThrow(PyError);
    expect(() => parseLinkedin(message({ ...li, body: li.body + "é".repeat(500_001) }))).toThrow(PyError);
  });
});

describe("read_notification", () => {
  it("reads, checks the envelope and parses as Python does, request for request", async () => {
    const bad = [];
    for (const c of golden.read_notification) {
      const calls: string[] = [];
      const client = new ReceivingClient("re_synthetic", { request: transport(c.pages, calls), pause: async () => {}, sources: [c.source] });
      const got = await attemptAsync(async () => {
        await client.listReceived();
        try {
          return { jobs: encode(await readNotification(client, "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", "test@inbox.resend.app", c.source, c.retry)) };
        } catch (e) {
          if (e instanceof NotificationError) return { stage: e.stage };
          throw e;
        }
      });
      if (!same(failed(got), failed(c.expect)) || !same(calls, c.calls)) bad.push({ c: c.expect, got, calls, want: c.calls });
    }
    expect(bad).toEqual([]);
  });
  it("fails a response past 2 MB at fetch", async () => {
    const big = new Uint8Array(MAX_BYTES + 1).fill(0x20);
    const client = new ReceivingClient("re_synthetic", { request: async () => ({ status: 200, body: big }), pause: async () => {} });
    await expect(client.listReceived()).rejects.toThrow("Resend read failed");
  });
  it("sends one bounded GET with the key, pausing 0.6 s between calls", async () => {
    const seen: [string, Record<string, string>][] = [], pauses: number[] = [];
    const body = new Uint8Array(Buffer.from('{"data": [], "has_more": false}'));
    const client = new ReceivingClient("re_synthetic", { request: async (url, headers) => (seen.push([url, headers]), { status: 200, body }), pause: async (s) => void pauses.push(s) });
    await client.listReceived();
    await client.listReceived("4ef9a417-02e9-4d39-ad75-9611e0fcc33c");
    expect(seen.map(([u]) => u)).toEqual(["https://api.resend.com/emails/receiving?limit=100", "https://api.resend.com/emails/receiving?limit=100&after=4ef9a417-02e9-4d39-ad75-9611e0fcc33c"]);
    expect(seen[0][1]).toEqual({ Authorization: "Bearer re_synthetic", Accept: "application/json", "User-Agent": "freelance-agent/0.1" });
    expect(pauses).toEqual([0.6]);
    expect(() => new ReceivingClient("sk_wrong")).toThrow(PyError);
    expect(() => new ReceivingClient("re_synthetic", { sources: ["guru"] })).toThrow(PyError);
    await expect(client.listReceived("../x" as string)).rejects.toThrow(PyError);
    expect(() => client.getReceived("4ef9a417-02e9-4d39-ad75-9611e0fcc33c", "linkedin")).toThrow("Retry source is not enabled");
  });
});


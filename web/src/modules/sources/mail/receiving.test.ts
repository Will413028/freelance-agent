import { describe, expect, it } from "vitest";
import type { Fetcher, FetchRequest } from "@/platform/fetch";
import { readMessage } from "./message";
import { MailRejection } from "./reasons";
import { assertReceivingUrl, inboxAddress, ReceivingClient, senderAddress } from "./receiving";

// Plan step 7a: the Resend Receiving client (GET only, Receiving URLs only, bodies only of listed
// messages from the source's sender) and the envelope checks every mail source shares.

const KEY = "re_test_key_123";
const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const OTHER = "1f0e0d0c-0b0a-4908-8706-050403020100";
const SENDER = "jobbank@ms1.104.com.tw";
const INBOX = "box@example.resend.app";

function fake(answer: (url: string) => unknown) {
  const seen: FetchRequest[] = [];
  const fetcher: Fetcher = {
    get requests() { return seen.length; },
    get: async (req) => {
      seen.push(req);
      return { status: 200, tier: "plain", body: new TextEncoder().encode(JSON.stringify(answer(req.url))) };
    },
  };
  return { fetcher, seen };
}

describe("Resend Receiving client", () => {
  it("refuses every URL but https://api.resend.com/emails/receiving[/…]", () => {
    for (const bad of ["https://api.resend.com/emails", "https://api.resend.com/emails/receivingx", "http://api.resend.com/emails/receiving",
      "https://u:p@api.resend.com/emails/receiving", "https://api.resend.com:8443/emails/receiving", "https://evil.example/emails/receiving", "nonsense"]) {
      expect(() => assertReceivingUrl(bad), bad).toThrow(/refused/);
    }
    expect(() => assertReceivingUrl("https://api.resend.com/emails/receiving/abc?html_format=cid")).not.toThrow();
  });

  it("lists with the key, reads only a message the list showed from the source's sender", async () => {
    const { fetcher, seen } = fake((url) => (url.includes("?limit") ? { has_more: false, data: [
      { id: ID, from: `104 <${SENDER.toUpperCase()}>`, subject: "s" }, { id: OTHER, from: "someone@else.example", subject: "s" }] } : { id: ID }));
    const client = new ReceivingClient(fetcher, KEY, SENDER);
    const page = await client.list(null);
    expect(page.entries.map((e) => e.sender)).toEqual([SENDER, "someone@else.example"]);
    await client.message(ID);
    await expect(client.message(OTHER)).rejects.toThrow(/not listed/);
    expect(seen.map((r) => [r.url, r.headers?.Authorization])).toEqual([
      ["https://api.resend.com/emails/receiving?limit=100", `Bearer ${KEY}`],
      [`https://api.resend.com/emails/receiving/${ID}?html_format=cid`, `Bearer ${KEY}`],
    ]);
  });

  it("refuses a malformed key, inbox, id, list or non-JSON answer", async () => {
    const { fetcher } = fake(() => ({}));
    expect(() => new ReceivingClient(fetcher, "sk_nope", SENDER)).toThrow(/Resend key/);
    expect(() => inboxAddress("me@gmail.com")).toThrow(/receiving address/);
    expect(inboxAddress("Box@Example.resend.app")).toBe(INBOX);
    const client = new ReceivingClient(fetcher, KEY, SENDER);
    await expect(client.list(null)).rejects.toThrow(/invalid Resend list/);
    await expect(client.list("../../emails")).rejects.toThrow(/invalid Resend id/);
    const text: Fetcher = { requests: 0, get: async () => ({ status: 200, tier: "plain", body: new TextEncoder().encode("<html>") }) };
    await expect(new ReceivingClient(text, KEY, SENDER).list(null)).rejects.toThrow(/other than JSON/);
  });

  it("reads one address from a From value, or none", () => {
    expect([senderAddress("a@b.c"), senderAddress("Name <A@B.c>"), senderAddress("a@b.c, d@e.f"), senderAddress("a@b.c\nX: y"), senderAddress(null)])
      .toEqual(["a@b.c", "a@b.c", null, null, null]);
  });
});

describe("envelope checks", () => {
  const raw = (changes: Record<string, unknown> = {}) => ({
    id: ID, from: SENDER, to: [INBOX], received_for: [], created_at: "2026-09-26T03:00:00.000Z", subject: "s", html: "<p>x</p>", text: "x", ...changes,
  });
  const reason = (r: Record<string, unknown>, preferText = false) => {
    try {
      readMessage(r, ID, SENDER, INBOX, preferText);
      return null;
    } catch (e) {
      return e instanceof MailRejection ? e.reason : String(e);
    }
  };

  it("passes a message for this inbox and reads its HTML part, or its text part when asked", () => {
    expect(readMessage(raw(), ID, SENDER, INBOX)).toMatchObject({ body: "<p>x</p>", isHtml: true, receivedAt: "2026-09-26T03:00:00.000Z" });
    expect(readMessage(raw({ html: null }), ID, SENDER, INBOX)).toMatchObject({ body: "x", isHtml: false });
    expect(readMessage(raw(), ID, SENDER, INBOX, true)).toMatchObject({ body: "x", isHtml: false });
    expect(reason(raw({ to: [], received_for: ["BOX@example.resend.app"] }))).toBeNull();
  });

  it("names each failed check", () => {
    expect([
      reason(raw({ id: OTHER })), reason(raw({ from: "x@y.z" })), reason(raw({ to: ["other@example.resend.app"] })),
      reason(raw({ created_at: "2026-09-26" })), reason(raw({ created_at: "2026-09-26T03:00:00" })), reason(raw({ subject: null })),
      reason(raw({ html: null, text: null })), reason(raw({ html: "x".repeat(2 * 1024 * 1024 + 1) })),
    ]).toEqual(["id_mismatch", "sender_mismatch", "recipient_mismatch", "bad_received_at", "bad_received_at", "missing_subject_or_body", "missing_subject_or_body", "body_too_large"]);
  });
});

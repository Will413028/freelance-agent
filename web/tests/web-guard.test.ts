import { describe, expect, it } from "vitest";
import { BODY_LIMIT, guardedForm, safePath } from "@/app/_lib/guard";

// Plan step 11: every write route checks the write switch, the request's origin, the content type and
// the body size before it reads the form (D23; the old LocalBoundary in backend bootstrap/http.py).

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://fa.example/jobs/x/feedback", {
    method: "POST",
    body,
    headers: { host: "fa.example", origin: "https://fa.example", "content-type": "application/x-www-form-urlencoded", ...headers },
  });

const status = async (request: Request, writes = true) => {
  const result = await guardedForm(request, writes);
  return result instanceof Response ? result.status : 200;
};

describe("web write guard", () => {
  it("accepts a same-origin form and returns its fields", async () => {
    const result = await guardedForm(post("value=interested&versions=%7B%7D"), true);
    expect(result).not.toBeInstanceOf(Response);
    const form = result as URLSearchParams;
    expect(form.get("value")).toBe("interested");
    expect(form.get("versions")).toBe("{}");
  });

  it("answers 403 while writes are off, whatever the request", async () => {
    expect(await status(post("value=interested"), false)).toBe(403);
  });

  it("answers 403 to another origin, a missing origin and a null origin", async () => {
    expect(await status(post("a=1", { origin: "https://evil.example" }))).toBe(403);
    expect(await status(post("a=1", { origin: "null" }))).toBe(403);
    const missing = new Request("https://fa.example/x", { method: "POST", body: "a=1", headers: { host: "fa.example", "content-type": "application/x-www-form-urlencoded" } });
    expect(await status(missing)).toBe(403);
  });

  it("compares with the forwarded host when a proxy sets one", async () => {
    expect(await status(post("a=1", { host: "internal:3000", "x-forwarded-host": "fa.example" }))).toBe(200);
    expect(await status(post("a=1", { host: "fa.example", "x-forwarded-host": "other.example" }))).toBe(403);
    expect(await status(post("a=1", { "x-forwarded-host": "fa.example, internal:3000" }))).toBe(200);
  });

  it("answers 415 to anything but a urlencoded form", async () => {
    expect(await status(post("{}", { "content-type": "application/json" }))).toBe(415);
    expect(await status(post("a=1", { "content-type": "multipart/form-data; boundary=x" }))).toBe(415);
  });

  it("answers 413 past the body limit, declared or not", async () => {
    const big = "a=" + "x".repeat(BODY_LIMIT);
    expect(await status(post(big))).toBe(413);
    const chunked = new Request("https://fa.example/x", {
      method: "POST",
      headers: { host: "fa.example", origin: "https://fa.example", "content-type": "application/x-www-form-urlencoded" },
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } }),
      duplex: "half",
    } as RequestInit);
    expect(chunked.headers.get("content-length")).toBeNull();
    expect(await status(chunked)).toBe(413);
  });

  it("sends the person back only to a path of this site", () => {
    expect(safePath("/jobs/a?view=saved")).toBe("/jobs/a?view=saved");
    for (const bad of ["//evil.example", "/\\evil.example", "/\t/evil.example", "https://evil.example", "", null, "jobs"]) expect(safePath(bad)).toBe("/");
  });

  it("marks every refusal no-store and nosniff", async () => {
    const result = await guardedForm(post("a=1"), false) as Response;
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

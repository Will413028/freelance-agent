import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pyIsInstance } from "./errors";
import { HttpError, raiseForUrllibStatus, urlopenRead } from "./http";

// urlopenRead keeps urllib's timeout model (plan step 8, batch 3 design review): a page that keeps
// sending within the per-chunk wait is read even when the whole read takes longer than any one wait.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let server: Server, base: string;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url ?? "";
    if (path === "/redirect") return res.writeHead(302, { Location: "/x" }).end();
    if (path === "/missing") return res.writeHead(404).end("gone");
    res.writeHead(200, { "Content-Type": "text/plain" });
    if (path === "/big") return res.end("x".repeat(2048));
    // /trickle/<n>/<gap ms>: n chunks, one every gap; /stall: one chunk, then nothing.
    const [, kind, n, gap] = path.split("/");
    if (kind === "stall") return res.write("a");
    for (let i = 0; i < Number(n); i++) {
      res.write("a");
      await sleep(Number(gap));
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const error = async (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe("urlopenRead", () => {
  it("reads a body that trickles in within the per-chunk wait, though it takes longer than one wait", async () => {
    const r = await urlopenRead(`${base}/trickle/6/150`, {}, 1000, 300, 300, 5000);
    expect([r.status, r.body.length]).toEqual([200, 6]);
  });
  it("a stalled body is an OSError after the per-chunk wait", async () => {
    const e = await error(urlopenRead(`${base}/stall`, {}, 1000, 300, 200, 5000));
    expect(pyIsInstance(e, "OSError")).toBe(true);
  });
  it("the source deadline ends a read that keeps trickling", async () => {
    const e = await error(urlopenRead(`${base}/trickle/50/100`, {}, 1000, 300, 300, 600));
    expect(pyIsInstance(e, "OSError") || pyIsInstance(e, "ValueError")).toBe(true);
  });
  it("past the cap it stops with read_body's ValueError", async () => {
    const e = await error(urlopenRead(`${base}/big`, {}, 1000, 300, 300, 5000));
    expect(pyIsInstance(e, "ValueError")).toBe(true);
  });
  it("hands back redirects and errors unread, which raiseForUrllibStatus maps as urllib does", async () => {
    const redirect = await urlopenRead(`${base}/redirect`, {}, 1000, 300, 300, 5000);
    const missing = await urlopenRead(`${base}/missing`, {}, 1000, 300, 300, 5000);
    expect([redirect.status, redirect.body.length, missing.status, missing.body.length]).toEqual([302, 0, 404, 0]);
    expect(() => raiseForUrllibStatus(302)).toThrow("redirects");
    expect(() => raiseForUrllibStatus(404)).toThrow(HttpError);
    expect(() => raiseForUrllibStatus(204)).not.toThrow();
  });
  it("an unreachable host is an OSError", async () => {
    const e = await error(urlopenRead("http://127.0.0.1:1/x", {}, 1000, 300, 300, 5000));
    expect(pyIsInstance(e, "OSError")).toBe(true);
  });
});

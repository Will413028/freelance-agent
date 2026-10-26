import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openGmail } from "./smtp";

// Plan step 10c review: connection failures reach nodemailer's SMTPConnection only as `error`
// events, so openGmail must end on them instead of waiting until the function is killed.
// Real sockets on loopback; no SMTP server, credentials or network.

const EMAIL = "owner@gmail.com", PASSWORD = "abcdefghijklmnop";
let server: Server | null = null;
const sockets: Socket[] = [];

async function listen(onSocket: (s: Socket) => void): Promise<number> {
  server = createServer((s) => { sockets.push(s); onSocket(s); });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server!.address() as { port: number }).port;
}

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.destroy());
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe("openGmail fails instead of hanging", () => {
  it("when the server drops the connection", async () => {
    const port = await listen((s) => s.destroy());
    await expect(openGmail(EMAIL, PASSWORD, { host: "127.0.0.1", port, timeoutMs: 5_000 }))
      .rejects.toThrow("Gmail SMTP configuration or authentication unavailable");
  });

  it("when the server never answers", async () => {
    const port = await listen(() => {});
    await expect(openGmail(EMAIL, PASSWORD, { host: "127.0.0.1", port, timeoutMs: 300 }))
      .rejects.toThrow("Gmail SMTP configuration or authentication unavailable");
  });

  it("without connecting when the account or app password is malformed", async () => {
    let connections = 0;
    const port = await listen(() => { connections++; });
    for (const [email, password] of [["owner@example.com", PASSWORD], [EMAIL, "abcd efgh ijkl mnop"]]) {
      await expect(openGmail(email, password, { host: "127.0.0.1", port, timeoutMs: 300 })).rejects.toThrow();
    }
    expect(connections).toBe(0);
  });
});

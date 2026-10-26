import SMTPConnection from "nodemailer/lib/smtp-connection";

// Port of platform/gmail_smtp.py: one verified TLS connection to Gmail, logged in before the caller
// claims anything, so a bad password or an unreachable server leaves the digest pending. nodemailer
// is only the SMTP transport; the message bytes are built by the caller (plan step 10c).

export type SmtpClient = {
  /** Sends the given bytes as they are; resolves with the recipients the server accepted. */
  send(from: string, to: string, raw: Uint8Array): Promise<{ accepted: string[]; rejected: string[] }>;
  close(): void;
};

const GMAIL = /^[A-Za-z0-9._+-]+@gmail\.com$/;
const APP_PASSWORD = /^[a-z]{16}$/;
const GMAIL_SERVER = { host: "smtp.gmail.com", port: 465, timeoutMs: 20_000 };

/** smtplib.SMTP_SSL('smtp.gmail.com', 465) and login; every failure is one fixed message, no provider text. */
export async function openGmail(email: string, password: string, server = GMAIL_SERVER): Promise<SmtpClient> {
  const fail = () => new Error("Gmail SMTP configuration or authentication unavailable");
  if (!GMAIL.test(email) || !APP_PASSWORD.test(password)) throw fail();
  const connection = new SMTPConnection({
    host: server.host, port: server.port, secure: true,
    connectionTimeout: server.timeoutMs, greetingTimeout: server.timeoutMs, socketTimeout: server.timeoutMs,
    tls: { servername: server.host, rejectUnauthorized: true },
  });
  // An error after the callbacks settle (a dropped socket) must not crash the function.
  connection.on("error", () => {});
  // Connection, TLS and timeout failures are only emitted as events, never passed to the connect or
  // login callbacks, so each wait also ends on them; otherwise the run would hang until it is killed.
  const settle = (start: (done: (err?: unknown) => void) => void) => new Promise<void>((resolve, reject) => {
    const closed = () => stop(new Error("closed"));
    const stop = (err?: unknown) => {
      connection.off("error", stop); connection.off("end", closed);
      return err === undefined ? resolve() : reject(err);
    };
    connection.once("error", stop);
    connection.once("end", closed);
    start(stop);
  });
  try {
    await settle((done) => connection.connect((err) => done(err ?? undefined)));
    await settle((done) => connection.login({ credentials: { user: email, pass: password } }, (err, ok) => done(err ?? (ok ? undefined : new Error()))));
  } catch {
    connection.close();
    throw fail();
  }
  return {
    send: (from, to, raw) => new Promise((resolve, reject) => connection.send({ from, to: [to] }, Buffer.from(raw),
      (err, info) => (err || !info ? reject(new Error("SMTP send failed")) : resolve({ accepted: info.accepted.map(String), rejected: info.rejected.map(String) })))),
    close: () => connection.quit(),
  };
}

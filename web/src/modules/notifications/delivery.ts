import { createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "@/db/client";
import { isCandidate } from "@/modules/discovery/public";
import { dateFromIsoformat, fromisoformat } from "@/platform/py/datetime";
import { casefold, pyStr } from "@/platform/py/unicode";
import { asDict, asList, PyDict, pyGet } from "@/platform/py/value";
import { openGmail, type SmtpClient } from "@/platform/smtp";
import { render, safeUrl, SOURCE_STATUS } from "./digest";
import { claimDigest, finishDigest, getDigest, type DigestRow } from "./outbox";

// Digest delivery (plan step 10c): notifications/scheduler.py's dispatch and gmail_smtp.py's deliver,
// with the MIME message built natively (D17). The bytes depend only on the stored snapshot and the
// intent id (fixed boundary, Message-ID and Date), so the preview sha256 a person approves is the
// sha256 of exactly what is sent. Uncertain outcomes are final: attempted and unknown never go back
// to pending, and nothing here retries.

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const encoder = new TextEncoder();

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** base64 in 76-character lines, as MIME bodies are folded. */
function base64Lines(text: string): string {
  return (Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

/** RFC 5322 date of an aware ISO timestamp, keeping its own offset. */
function rfc5322(iso: string): string {
  const t = fromisoformat(iso);
  if (t.offset === null) throw new Error("Snapshot requires an aware timestamp");
  const p = (n: number | bigint, w = 2) => String(n).padStart(w, "0");
  const minutes = t.offset / 60_000_000n, sign = minutes < 0n ? "-" : "+", abs = minutes < 0n ? -minutes : minutes;
  const day = DAYS[new Date(Date.UTC(t.year, t.month - 1, t.day)).getUTCDay()];
  return `${day}, ${p(t.day)} ${MONTHS[t.month - 1]} ${p(t.year, 4)} ${p(t.hour)}:${p(t.minute)}:${p(t.second)} ${sign}${p(abs / 60n)}${p(abs % 60n)}`;
}

function plainText(snapshot: PyDict, localDate: string, items: PyDict[]): string {
  const lines = [`接案摘要 · ${localDate}`, "案件條件仍需人工確認；本信不代表已投遞。", ""];
  if (snapshot.has("unseen_count")) lines.push(`新案／更新 ${pyStr(snapshot.req("unseen_count"))} 件；本信列出 ${items.length} 件候選。`);
  for (const item of items) {
    const rank = pyGet(item, "recommendation");
    if (rank instanceof PyDict) lines.push(`推薦排序 ${pyStr(rank.req("score"))} 分 · 資訊完整度 ${pyStr(rank.req("completeness"))}%（非成交機率）`);
    const job = item.dict("job");
    lines.push(pyStr(job.req("title")), asList(item.dict("evaluation").req("questions")).map(pyStr).join("；"), safeUrl(pyGet(job, "url", "")), "");
  }
  if (!items.length) lines.push("目前沒有可列出的候選；請同時檢查來源狀態。");
  lines.push("來源狀態", ...[...snapshot.dict("sources")].map(([name, state]) =>
    `${name}：${typeof state === "string" && Object.hasOwn(SOURCE_STATUS, state) ? SOURCE_STATUS[state] : "狀態未知"}`));
  return lines.join("\n") + "\n";
}

/** The digest message: only to the verified account, from itself; the same snapshot always gives the same bytes. */
export function buildMessage(snapshot: PyDict, intentId: string, email: string): Uint8Array {
  if (!ADDRESS.test(email) || casefold(snapshot.str("recipient")) !== casefold(email)) {
    throw new Error("Digest must be addressed only to the verified account");
  }
  const to = snapshot.str("recipient");
  const localDate = dateFromIsoformat(snapshot.str("local_date"));
  const date = rfc5322(snapshot.str("generated_at"));
  const key = sha256(intentId);
  const items = asList(snapshot.req("items")).map(asDict).filter(isCandidate);
  const html = render(items, snapshot.dict("sources"), { mode: "sqlite", email: true, counts: snapshot });
  const boundary = `digest_${key}`;
  const subject = `=?utf-8?b?${Buffer.from(`接案摘要 · ${localDate}`, "utf8").toString("base64")}?=`;
  const part = (type: string, body: string) =>
    `--${boundary}\r\nContent-Type: ${type}; charset="utf-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(body)}\r\n`;
  return encoder.encode([
    `From: ${to}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${date}`, `Message-ID: <${key}@freelance-agent.local>`,
    "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "", "",
  ].join("\r\n") + part("text/plain", plainText(snapshot, localDate, items)) + part("text/html", html) + `--${boundary}--\r\n`);
}

export const messageSha256 = (raw: Uint8Array) => sha256(raw);

/**
 * scheduler.dispatch: claim (committed before the sender runs), call the sender once, and record
 * sent with its receipt or unknown. A thrown error or a missing receipt is unknown, never a retry.
 */
export async function dispatch(db: Db, id: string, sender: (snapshot: PyDict) => Promise<string | null>): Promise<DigestRow> {
  const intent = await claimDigest(db, id);
  if (!intent) return getDigest(db, id);
  let receipt: string | null;
  try {
    receipt = await sender(intent.snapshot);
  } catch {
    return finishDigest(db, id, "unknown");
  }
  return typeof receipt === "string" && receipt.trim() ? finishDigest(db, id, "sent", receipt) : finishDigest(db, id, "unknown");
}

export type SmtpOpener = (email: string) => Promise<SmtpClient>;

/**
 * gmail_smtp.deliver: only a pending digest, only when the message matches the approved sha256, and
 * only after the connection is logged in. Errors before the claim leave the digest pending.
 */
export async function deliver(db: Db, id: string, email: string, expectedSha256: string, open: SmtpOpener): Promise<DigestRow> {
  const intent = await getDigest(db, id);
  if (intent.status !== "pending") return intent;
  const raw = buildMessage(intent.snapshot, id, email);
  const actual = Buffer.from(messageSha256(raw)), expected = Buffer.from(String(expectedSha256));
  if (!/^[a-f0-9]{64}$/.test(String(expectedSha256)) || !timingSafeEqual(actual, expected)) throw new Error("Preview hash mismatch");
  const client = await open(email);
  try {
    return await dispatch(db, id, async (snapshot) => {
      // The claimed row must still be the reviewed bytes.
      if (!Buffer.from(buildMessage(snapshot, id, email)).equals(Buffer.from(raw))) throw new Error("Snapshot changed");
      const sent = await client.send(email, email, raw);
      if (sent.rejected.length || !sent.accepted.some((a) => casefold(a) === casefold(email))) throw new Error("Recipient refused");
      return `smtp-accepted:${id}`;
    });
  } finally {
    try { client.close(); } catch { /* closing never changes the outcome */ }
  }
}

/** The Gmail app password, or null when delivery is not configured (shadow, plan step 13 stores it). */
export function smtpPassword(value = process.env.GMAIL_APP_PASSWORD): string | null {
  return value === undefined || value === "" ? null : value;
}

export const gmailOpener = (password: string): SmtpOpener => (email) => openGmail(email, password);

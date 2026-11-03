// The checks every page write passes before it reads its form (plan step 11, D23). Vercel
// Authentication decides who reaches the app; these decide what a request may do once it does:
// writes are off until the cutover, a write must come from a page of this same host (a form another
// site posts carries its own Origin), only a urlencoded form is read, and only up to BODY_LIMIT.

/** Headers on every page-write response, refusals included. */
export const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;

/** The largest form a write reads, in bytes: a settings form is under 1 KiB. */
export const BODY_LIMIT = 16 * 1024;

/** Whether page writes are on: WEB_WRITES=on, set at the cutover (plan step 13), never before. */
export const writesOn = (env: Record<string, string | undefined> = process.env) => env.WEB_WRITES === "on";

/** A short HTML page with `status`: what the person reads after a refused or failed write. */
export function messagePage(status: number, message: string, back = "/"): Response {
  const body = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>${escapeHtml(message)}</title>`
    + `<main><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(safePath(back))}">返回</a></p></main></html>`;
  return new Response(body, { status, headers: { ...NO_STORE, "content-type": "text/html; charset=utf-8" } });
}

/** The form of a write request that passed every check, or the refusal to answer with. */
export async function guardedForm(request: Request, writes: boolean): Promise<URLSearchParams | Response> {
  if (!writes) return messagePage(403, "切換到正式系統前，網頁只能瀏覽，回饋與設定暫不開放");
  // A proxy chain may list several hosts; the first is the one the browser asked for (as Next's server-action check reads it).
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host"))?.split(",")[0].trim();
  if (!host || originHost(request.headers.get("origin")) !== host) return messagePage(403, "不允許的來源");
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return messagePage(415, "請求格式不正確");
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= BODY_LIMIT)) return messagePage(413, "請求大小不符限制");
  const body = await readCapped(request, BODY_LIMIT);
  if (body === null) return messagePage(413, "請求大小不符限制");
  return new URLSearchParams(body);
}

function originHost(origin: string | null): string | null {
  if (!origin || origin === "null") return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** The body as text, or null once it passes `limit` bytes (counted as read, whatever was declared). */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

/** A same-site path to send the person back to: anything else becomes "/". */
export function safePath(path: string | null | undefined): string {
  // No backslash or control character at all: browsers read "\" as "/" and drop tabs and newlines,
  // so "/\x" or "/\t/x" would become the other site "//x".
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(path) ? path : "/";
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

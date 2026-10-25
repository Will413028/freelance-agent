import { decodeStrict } from "./py/codecs";
import { loads } from "./py/json";
import { PyError, type PyValue } from "./py/value";

// The urllib pattern the Python connectors share: one GET, no redirects, a size cap read as
// r.read(cap + 1). urllib's timeout applies per socket operation; here it bounds the whole request,
// which is stricter and only turns a very slow feed into a failed source.

export async function getCapped(url: string, headers: Record<string, string>, maxBytes: number, timeoutMs: number): Promise<{ status: number; body: Uint8Array }> {
  const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        break;
      }
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) body.set(c, offset), (offset += c.length);
  return { status: response.status, body };
}

/** json.detect_encoding */
function detectEncoding(b: Uint8Array): string {
  const starts = (...bytes: number[]) => bytes.every((x, i) => b[i] === x);
  if (b.length >= 4 && (starts(0, 0, 0xfe, 0xff) || starts(0xff, 0xfe, 0, 0))) return "utf-32";
  if (b.length >= 2 && (starts(0xfe, 0xff) || starts(0xff, 0xfe))) return "utf-16";
  if (starts(0xef, 0xbb, 0xbf)) return "utf-8-sig";
  if (b.length >= 4) {
    if (!b[0]) return b[1] ? "utf-16-be" : "utf-32-be";
    if (!b[1]) return b[2] || b[3] ? "utf-16-le" : "utf-32-le";
  } else if (b.length === 2) {
    if (!b[0]) return "utf-16-be";
    if (!b[1]) return "utf-16-le";
  }
  return "utf-8";
}

function decodeUtf32(b: Uint8Array, littleEndian: boolean): string {
  if (b.length % 4) throw new PyError("UnicodeDecodeError");
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let out = "";
  for (let i = 0; i < b.length; i += 4) {
    const cp = view.getUint32(i, littleEndian);
    if (cp > 0x10ffff) throw new PyError("UnicodeDecodeError");
    out += String.fromCodePoint(cp);
  }
  return out;
}

/**
 * json.loads(bytes). Python decodes with 'surrogatepass', so encoded lone surrogates load there
 * and fail here (UnicodeDecodeError); neither public feed sends them.
 */
export function loadsBytes(b: Uint8Array): PyValue {
  const encoding = detectEncoding(b);
  const decode = decodeStrict;
  let text: string;
  if (encoding === "utf-8") text = decode("utf-8", b);
  else if (encoding === "utf-8-sig") text = decode("utf-8", b.subarray(3));
  else if (encoding === "utf-16") text = decode(b[0] === 0xff ? "utf-16le" : "utf-16be", b.subarray(2));
  else if (encoding === "utf-16-le" || encoding === "utf-16-be") text = decode(encoding.replace("-le", "le").replace("-be", "be"), b);
  else if (encoding === "utf-32") text = decodeUtf32(b.subarray(4), b[0] === 0xff);
  else text = decodeUtf32(b, encoding === "utf-32-le");
  return loads(text);
}

/** urllib.error.HTTPError (an OSError): a status urllib's opener does not hand back as a response. */
export class HttpError extends PyError {
  constructor(readonly code: number) {
    super("HTTPError", `HTTP Error ${code}`);
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * What urllib's opener with public_feeds.NoRedirect raises for a status: a redirect is NoRedirect's
 * ValueError, a non-2xx HTTPError; a 2xx is returned for the caller to check.
 */
export function raiseForUrllibStatus(status: number): void {
  if (REDIRECTS.has(status)) throw new PyError("ValueError", "Public feed redirects are unsupported");
  if (status < 200 || status > 299) throw new HttpError(status);
}

/**
 * One GET as urlopen(timeout=connectMs) without redirects, its body read the way ptt_soho.read_body
 * reads: each chunk may wait min(chunkMs, time left), the whole read ends `remainingMs` from now, and
 * past `maxBytes` it stops. A timeout or network failure is an OSError, like socket.timeout; data that
 * arrives after the deadline is read_body's ValueError. A non-2xx response comes back without its
 * body, for raiseForUrllibStatus.
 */
export async function urlopenRead(url: string, headers: Record<string, string>, maxBytes: number, connectMs: number, chunkMs: number, remainingMs: number): Promise<{ status: number; body: Uint8Array }> {
  const deadline = performance.now() + remainingMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), Math.max(0, ms));
  };
  const late = () => new PyError("ValueError", "Source time budget exceeded");
  try {
    arm(Math.min(connectMs, remainingMs));
    let response: Response;
    try {
      response = await fetch(url, { headers, redirect: "manual", signal: controller.signal });
    } catch (e) {
      throw new PyError("OSError", (e as Error).message);
    }
    if (response.status < 200 || response.status > 299 || !response.body) {
      await response.body?.cancel().catch(() => {});
      return { status: response.status, body: new Uint8Array() };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw (await reader.cancel().catch(() => {}), late());
      arm(Math.min(chunkMs, remaining));
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        throw new PyError("OSError", (e as Error).message);
      }
      if (performance.now() > deadline) throw (await reader.cancel().catch(() => {}), late());
      if (chunk.done) break;
      chunks.push(chunk.value);
      size += chunk.value.length;
      if (size > maxBytes) throw (await reader.cancel().catch(() => {}), new PyError("ValueError", "Response limit"));
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) body.set(c, offset), (offset += c.length);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

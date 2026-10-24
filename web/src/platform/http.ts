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

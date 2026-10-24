import { PyError } from "./value";

/** bytes.decode(codec) with errors='strict': a BOM stays in the text, invalid input raises UnicodeDecodeError. */
export function decodeStrict(label: string, raw: Uint8Array): string {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new PyError("UnicodeDecodeError", `'${label}' codec can't decode bytes`);
  }
}

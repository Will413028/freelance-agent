import { SaxesParser } from "saxes";
import { PyError } from "./value";

// xml.etree.ElementTree.fromstring(bytes) and the find/findall/findtext paths the RSS sources use.
// CPython parses with expat; saxes is also a strict XML 1.0 + namespaces parser, so a feed one
// rejects the other rejects too. Callers reject DOCTYPE/ENTITY before parsing, so no DTD is ever read.
// Accepted residuals (2026-10-24 differential fuzz, ~300k cases; none occurs in the real feed):
// saxes uses the 5th-edition name characters where expat 2.8.5 uses Appendix B (non-ASCII element
// names), trims namespace URIs and accepts '}' in them, and this decoder rejects single-byte codecs
// other than ISO-8859-1/US-ASCII, BOM-less UTF-16 and a latin-1 declaration after a UTF-8 BOM.

/** attrib keys as ElementTree names them: 'local' without a prefix, '{uri}local' with one; no xmlns declarations. */
export type XmlElement = { tag: string; text: string | null; attrib: Map<string, string>; children: XmlElement[] };

const XMLNS = "http://www.w3.org/2000/xmlns/";

const parseError = (message: string) => new PyError("ParseError", message);

const declaredEncoding = (head: string) =>
  /^<\?xml[ \t\r\n][^>]*?encoding[ \t\r\n]*=[ \t\r\n]*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/.exec(head)?.[2].toLowerCase();

/** The bytes as expat would read them: BOM, then the declared encoding, else UTF-8. */
function decode(raw: Uint8Array): string {
  // A BOM fixes the encoding; a declaration that names another one is an error in expat.
  const withBom = (label: string, allowed: string[], body: Uint8Array) => {
    const s = strict(label, body);
    const declared = declaredEncoding(s.slice(0, 200));
    if (declared && !allowed.includes(declared)) throw parseError("encoding specified in XML declaration is incorrect");
    return s;
  };
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return withBom("utf-8", ["utf-8"], raw.subarray(3));
  if (raw[0] === 0xfe && raw[1] === 0xff) return withBom("utf-16be", ["utf-16", "utf-16be"], raw.subarray(2));
  if (raw[0] === 0xff && raw[1] === 0xfe) return withBom("utf-16le", ["utf-16", "utf-16le"], raw.subarray(2));
  const declared = declaredEncoding(Buffer.from(raw.subarray(0, 200)).toString("latin1"));
  if (!declared || declared === "utf-8") return utf8(raw);
  if (declared === "us-ascii") {
    if (raw.some((b) => b > 0x7f)) throw parseError("not well-formed (invalid token)");
    return Buffer.from(raw).toString("latin1");
  }
  if (declared === "iso-8859-1" || declared === "latin1" || declared === "latin-1") return Buffer.from(raw).toString("latin1");
  // pyexpat also accepts other single-byte codecs (e.g. cp1252); the ported sources serve UTF-8.
  throw parseError(`unsupported encoding ${declared}`);
}
const strict = (label: string, b: Uint8Array) => {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    throw parseError("not well-formed (invalid token)");
  }
};
const utf8 = (b: Uint8Array) => strict("utf-8", b);

/** ET.fromstring(raw) */
export function xmlFromBytes(raw: Uint8Array): XmlElement {
  const text = decode(raw);
  // decode() has consumed the one BOM expat honours; saxes would also skip a second one, expat rejects it.
  if (text.startsWith("\ufeff")) throw parseError("not well-formed (invalid token)");
  // expat reads every document as XML 1.0; saxes would otherwise honour version="1.1" (NEL as newline, &#1;).
  const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: "1.0", forceXMLVersion: true });
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let error: Error | null = null;
  // Character data goes to the open element's text until its first child (the tail is unused).
  const data = (s: string) => {
    const top = stack.at(-1);
    if (top && !top.children.length && s) top.text = (top.text ?? "") + s;
  };
  parser.on("error", (e) => { error ??= e; });
  parser.on("opentag", (node) => {
    const attrib = new Map<string, string>();
    for (const a of Object.values(node.attributes)) {
      if (a.uri === XMLNS) continue;
      attrib.set(a.prefix ? `{${a.uri}}${a.local}` : a.local, a.value);
    }
    const el: XmlElement = { tag: node.uri ? `{${node.uri}}${node.local}` : node.local!, text: null, attrib, children: [] };
    stack.at(-1)?.children.push(el);
    if (!stack.length) root = el;
    stack.push(el);
  });
  parser.on("closetag", () => { stack.pop(); });
  parser.on("text", data);
  parser.on("cdata", data);
  parser.write(text).close();
  if (error || !root) throw parseError((error as Error | null)?.message ?? "no element found");
  return root;
}

/** Element.find / findall for the simple 'tag', './a/b' and 'a/b' paths. */
export function xmlFindAll(el: XmlElement, path: string): XmlElement[] {
  let level = [el];
  // A '{uri}' qualifier may itself contain '/'.
  for (const step of path.match(/(?:\{[^}]*\}|[^/])+/g) ?? []) {
    if (step === ".") continue;
    level = level.flatMap((e) => e.children.filter((c) => c.tag === step));
  }
  return level;
}
export const xmlFind = (el: XmlElement, path: string): XmlElement | null => xmlFindAll(el, path)[0] ?? null;
/** Element.get(key): None when absent. */
export const xmlGet = (el: XmlElement, key: string): string | null => el.attrib.get(key) ?? null;

/** Element.findtext(path): None when absent, '' when present without text. */
export function xmlFindText(el: XmlElement, path: string): string | null {
  const hit = xmlFind(el, path);
  return hit === null ? null : hit.text ?? "";
}

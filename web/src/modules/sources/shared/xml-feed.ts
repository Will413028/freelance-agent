import { SaxesParser } from "saxes";

// XML feeds and the URL split the feed sources use (plan step 5a: cryptojobslist, v2ex). The parser is strict XML 1.0 with namespaces (saxes) and never reads a DTD: a
// document with one is refused. Element text is the character data before its first child, the way
// the old ElementTree readers saw it.

export type XmlElement = { tag: string; attrs: Map<string, string>; text: string; children: XmlElement[] };

const XMLNS = "http://www.w3.org/2000/xmlns/";

const declaredEncoding = (head: string) =>
  /^<\?xml[ \t\r\n][^>]*?encoding[ \t\r\n]*=[ \t\r\n]*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/.exec(head)?.[2].toLowerCase();

const strictDecode = (label: string, b: Uint8Array) => new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(b);

/** The bytes as text: a BOM decides, else the declared encoding (UTF-8, ISO-8859-1, US-ASCII), else UTF-8. Throws on anything else. */
function decode(raw: Uint8Array): string {
  const bom = (label: string, allowed: string[], body: Uint8Array) => {
    const s = strictDecode(label, body);
    const declared = declaredEncoding(s.slice(0, 200));
    if (declared && !allowed.includes(declared)) throw new Error("declared encoding contradicts the BOM");
    return s;
  };
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return bom("utf-8", ["utf-8"], raw.subarray(3));
  if (raw[0] === 0xfe && raw[1] === 0xff) return bom("utf-16be", ["utf-16", "utf-16be"], raw.subarray(2));
  if (raw[0] === 0xff && raw[1] === 0xfe) return bom("utf-16le", ["utf-16", "utf-16le"], raw.subarray(2));
  const declared = declaredEncoding(Buffer.from(raw.subarray(0, 200)).toString("latin1"));
  if (!declared || declared === "utf-8") return strictDecode("utf-8", raw);
  if (declared === "us-ascii") {
    if (raw.some((b) => b > 0x7f)) throw new Error("not ASCII");
    return Buffer.from(raw).toString("latin1");
  }
  // Buffer's latin1 is ISO-8859-1; TextDecoder's "iso-8859-1" label is windows-1252.
  if (declared === "iso-8859-1" || declared === "latin1" || declared === "latin-1") return Buffer.from(raw).toString("latin1");
  throw new Error(`unsupported encoding ${declared}`);
}

/** The document's root element; throws when the bytes are not well-formed XML or carry a DTD. */
export function parseXml(raw: Uint8Array): XmlElement {
  const text = decode(raw);
  // decode() has consumed the one BOM a document may carry; another is not well-formed.
  if (text.startsWith("\ufeff")) throw new Error("second BOM");
  const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: "1.0", forceXMLVersion: true });
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null, error: Error | null = null;
  const data = (s: string) => {
    const top = stack.at(-1);
    if (top && !top.children.length) top.text += s;
  };
  parser.on("error", (e) => { error ??= e; });
  parser.on("doctype", () => { error ??= new Error("DTD forbidden"); });
  parser.on("opentag", (node) => {
    const attrs = new Map<string, string>();
    for (const a of Object.values(node.attributes)) {
      if (a.uri === XMLNS) continue;
      attrs.set(a.prefix ? `{${a.uri}}${a.local}` : a.local, a.value);
    }
    const el: XmlElement = { tag: node.uri ? `{${node.uri}}${node.local}` : node.local!, attrs, text: "", children: [] };
    stack.at(-1)?.children.push(el);
    if (!stack.length) root = el;
    stack.push(el);
  });
  parser.on("closetag", () => { stack.pop(); });
  parser.on("text", data);
  parser.on("cdata", data);
  parser.write(text).close();
  if (error || !root) throw new Error((error as Error | null)?.message ?? "no element");
  return root;
}

export const children = (el: XmlElement, tag: string) => el.children.filter((c) => c.tag === tag);
/** The first child's text: null without such a child, "" when it has none. */
export const childText = (el: XmlElement, tag: string): string | null => children(el, tag)[0]?.text ?? null;

import { SaxesParser } from "saxes";

// A strict XML 1.0 + namespaces element tree, the parts ElementTree.fromstring(str) gave the old
// connector: tag ('{uri}local' with a namespace), text before the first child, attributes without
// xmlns declarations, children. Callers refuse DOCTYPE and ENTITY before parsing; a DTD is never read.
// Native counterpart of platform/py/xml.ts's string path (same saxes options), which sources may not
// import. It and shared/xml-feed.ts are two shapes over the same saxes options; step 5b merges them
// into shared/ (plan step 5 progress row).

export type XmlElement = { tag: string; text: string | null; attrib: Map<string, string>; children: XmlElement[] };

const XMLNS = "http://www.w3.org/2000/xmlns/";

/** The element tree of a document; throws on any well-formedness error or a DTD. */
export function parseXml(text: string): XmlElement {
  // ElementTree skipped one leading BOM; expat rejected a second one, which saxes would skip.
  if (text.startsWith("﻿")) text = text.slice(1);
  if (text.startsWith("﻿")) throw new Error("not well-formed (invalid token)");
  const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: "1.0", forceXMLVersion: true });
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null, error: Error | null = null;
  const data = (s: string) => {
    const top = stack.at(-1);
    if (top && !top.children.length && s) top.text = (top.text ?? "") + s;
  };
  parser.on("error", (e) => { error ??= e; });
  parser.on("doctype", () => { error ??= new Error("DTD forbidden"); });
  parser.on("opentag", (node) => {
    const attrib = new Map<string, string>();
    for (const a of Object.values(node.attributes)) {
      if (a.uri === XMLNS) continue;
      attrib.set(a.prefix ? `{${a.uri}}${a.local}` : a.local, a.value);
    }
    const el: XmlElement = { tag: node.uri ? `{${node.uri}}${node.local}` : node.local, text: null, attrib, children: [] };
    stack.at(-1)?.children.push(el);
    if (!stack.length) root = el;
    stack.push(el);
  });
  parser.on("closetag", () => { stack.pop(); });
  parser.on("text", data);
  parser.on("cdata", data);
  parser.write(text).close();
  if (error || !root) throw new Error((error as Error | null)?.message ?? "no element found");
  return root;
}

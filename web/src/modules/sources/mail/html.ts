import { load } from "cheerio";
import { reject } from "./reasons";

/** The parts of a domhandler node the mail parsers read (cheerio does not export the type). */
export type AnyNode = { type: string; data?: string; name?: string; attribs?: Record<string, string>; children?: AnyNode[] };

/** Deeper markup than any real notification; the parsers walk the tree recursively. */
export const MAX_DEPTH = 500;

/**
 * A mail body's HTML as a node tree, read with htmlparser2 through cheerio (document order, nested links
 * kept visible, not repaired as HTML5 would). The depth is measured without recursion first, so a body
 * nested deeper than MAX_DEPTH is a rejected message, never a stack overflow that would fail the source
 * and leave the message to be read again on every run.
 */
export function loadMailHtml(html: string): AnyNode {
  const root = load(html, { xml: { xmlMode: false, decodeEntities: true } }, false).root()[0] as unknown as AnyNode;
  const stack: [AnyNode, number][] = [[root, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (depth > MAX_DEPTH) reject("html_too_deep");
    for (const c of node.children ?? []) stack.push([c, depth + 1]);
  }
  return root;
}

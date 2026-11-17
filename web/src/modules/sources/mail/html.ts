import { load } from "cheerio";
import { Parser } from "htmlparser2";
import { collapseSpaces } from "../shared/text";
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

export type HtmlHandlers = {
  starttag?: (tag: string, attribs: Record<string, string>) => void;
  /** `implied`: the body never closed this element; the parser closed it (end of input, or a tag that implies it). */
  endtag?: (tag: string, implied: boolean) => void;
  data?: (text: string) => void;
  comment?: (text: string) => void;
};

/**
 * A body's HTML as a stream of events in document order (htmlparser2, the parser cheerio uses), for
 * parsers written as a scan. Unlike the tree, the stream tells an element the body closed from one the
 * parser closed for it, so a parser can refuse a cut-off or unbalanced template. An end tag with no open
 * element is dropped by the parser and never seen. Text may arrive in several pieces; a comment comes whole.
 * No recursion, so nesting depth needs no limit here.
 */
export function replay(html: string, on: HtmlHandlers): void {
  const parser = new Parser({
    onopentag: (name, attribs) => on.starttag?.(name, attribs),
    onclosetag: (name, implied) => on.endtag?.(name, implied),
    ontext: (text) => on.data?.(text),
    oncomment: (text) => on.comment?.(text),
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.end(html);
}

/** Text pieces joined and with every whitespace run collapsed to one space. */
export const squash = (parts: string[]) => collapseSpaces(parts.join(""));

import tables from "./html-tables.json";
import { codePoints, pyLower, pyStrip } from "./unicode";
import { PyError } from "./value";

// html.unescape and html.parser.HTMLParser of CPython 3.13.15, the version in the production image
// (3.13.13 closes empty comments differently). html-tables.json is written by
// docs/plans/2026-10-23-nextjs-vercel-migration/spike-1c/gen_expected.py.
// Indices are UTF-16 offsets; patterns that count characters use the u flag or codePoints().

const T = tables as unknown as { html5: Record<string, string>; invalid_charrefs: Record<string, string>; invalid_codepoints: number[] };
const HTML5 = new Map(Object.entries(T.html5));
const INVALID_CODEPOINTS = new Set(T.invalid_codepoints);
const MAX_STR_DIGITS = 4300;

function replaceCharref(s: string): string {
  if (s[0] === "#") {
    const hex = s[1] === "x" || s[1] === "X";
    const digits = (hex ? s.slice(2) : s.slice(1)).replace(/;+$/, "");
    if (!hex && digits.length > MAX_STR_DIGITS) throw new PyError("ValueError", "Exceeds the limit (4300 digits) for integer string conversion");
    const num = BigInt(hex ? "0x" + digits : digits);
    const key = num.toString();
    if (Object.hasOwn(T.invalid_charrefs, key)) return T.invalid_charrefs[key];
    if ((num >= 0xd800n && num <= 0xdfffn) || num > 0x10ffffn) return "�";
    if (INVALID_CODEPOINTS.has(Number(num))) return "";
    return String.fromCodePoint(Number(num));
  }
  const exact = HTML5.get(s);
  if (exact !== undefined) return exact;
  const cps = codePoints(s);
  for (let x = cps.length - 1; x > 1; x--) {
    const prefix = String.fromCodePoint(...cps.slice(0, x));
    const hit = HTML5.get(prefix);
    if (hit !== undefined) return hit + String.fromCodePoint(...cps.slice(x));
  }
  return "&" + s;
}

/** html.unescape */
export function unescape(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu, (_, ref: string) => replaceCharref(ref));
}

/** html.parser._unescape_attrvalue: numeric refs always, named refs only exact and not before '='. */
export function unescapeAttrValue(s: string): string {
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*)[;=]?/g, (ref: string) => {
    if (ref.startsWith("&#")) return unescape(ref);
    if (!ref.endsWith("=") && HTML5.has(ref.slice(1))) return unescape(ref);
    return ref;
  });
}

export type HtmlHandler = {
  starttag?(tag: string): void;
  endtag?(tag: string): void;
  data?(data: string): void;
};

const STARTTAGOPEN = /<[a-zA-Z]/y;
const ENDTAGOPEN = /<\/[a-zA-Z]/y;
const COMMENTCLOSE = /--!?>/g;
const COMMENTABRUPTCLOSE = /-?>/y;
const TAGFIND = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/uy;
const ATTRFIND = new RegExp(
  `((?<=['"\\t\\n\\r\\f /])[^\\t\\n\\r\\f />][^\\t\\n\\r\\f /=>]*)` +
  `([\\t\\n\\r\\f ]*=[\\t\\n\\r\\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\\t\\n\\r\\f ]*))?` +
  `(?:[\\t\\n\\r\\f ]|/(?!>))*`, "uy");
const LOCATETAGEND = new RegExp(
  `[a-zA-Z][^\\t\\n\\r\\f />]*[\\t\\n\\r\\f /]*` +
  `(?:(?<=['"\\t\\n\\r\\f /])[^\\t\\n\\r\\f />][^\\t\\n\\r\\f /=>]*` +
  `(?:[\\t\\n\\r\\f ]*=[\\t\\n\\r\\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\\t\\n\\r\\f ]*))?` +
  `[\\t\\n\\r\\f /]*)*>?`, "uy");
const CDATA_CONTENT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes"]);
const RCDATA_CONTENT = new Set(["textarea", "title"]);

function matchAt(re: RegExp, s: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(s);
}

/** Offset of the code point `count` code points before the end (Python's n - count), clamped at 0. */
function backFromEnd(s: string, count: number): number {
  let i = s.length;
  for (let k = 0; k < count && i > 0; k++) {
    const lo = s.charCodeAt(i - 1);
    i -= i >= 2 && lo >= 0xdc00 && lo <= 0xdfff && s.charCodeAt(i - 2) >= 0xd800 && s.charCodeAt(i - 2) <= 0xdbff ? 2 : 1;
  }
  return i;
}

/**
 * One HTMLParser().feed(data) on a fresh parser (convert_charrefs=True), without close(): input
 * the parser holds back at the end (an unterminated tag or comment, an unclosed script, a trailing
 * '&name') is dropped, exactly as in the Python callers.
 */
export function htmlFeed(rawdata: string, h: HtmlHandler): void {
  const n = rawdata.length;
  let cdataElem: string | null = null;
  let escapable = true;
  let interesting: RegExp | null = null;
  const data = (s: string) => h.data?.(s);
  const setCdata = (elem: string, esc: boolean) => {
    cdataElem = elem;
    escapable = esc;
    interesting = elem === "plaintext" ? /$/g : new RegExp(`</${elem}(?=[\\t\\n\\r\\f />])`, "gi");
  };
  const clearCdata = () => {
    cdataElem = null;
    escapable = true;
    interesting = null;
  };
  const bogusComment = (i: number) => {
    const pos = rawdata.indexOf(">", i + 2);
    return pos === -1 ? -1 : pos + 1;
  };
  const parseStarttag = (i: number) => {
    const m = matchAt(LOCATETAGEND, rawdata, i + 1)!;
    const endpos = m.index + m[0].length;
    if (rawdata[endpos - 1] !== ">") return -1;
    const t = matchAt(TAGFIND, rawdata, i + 1)!;
    let k = t.index + t[0].length;
    const tag = pyLower(t[1]);
    while (k < endpos) {
      const a = matchAt(ATTRFIND, rawdata, k);
      if (!a) break;
      // Attribute values are unused, but unescaping one can raise (a decimal ref over 4300 digits),
      // which fails the whole Python source.
      let value = a[2] ? a[3] : "";
      if ((value[0] === "'" && value.at(-1) === "'") || (value[0] === '"' && value.at(-1) === '"')) value = value.slice(1, -1);
      if (value) unescapeAttrValue(value);
      k = a.index + a[0].length;
    }
    const end = pyStrip(rawdata.slice(k, endpos));
    if (end !== ">" && end !== "/>") {
      data(rawdata.slice(i, endpos));
      return endpos;
    }
    if (end.endsWith("/>")) {
      h.starttag?.(tag);
      h.endtag?.(tag);
    } else {
      h.starttag?.(tag);
      if (CDATA_CONTENT.has(tag) || tag === "plaintext") setCdata(tag, false);
      else if (RCDATA_CONTENT.has(tag)) setCdata(tag, true);
    }
    return endpos;
  };
  const parseEndtag = (i: number) => {
    if (rawdata.indexOf(">", i + 2) < 0) return -1;
    if (!matchAt(ENDTAGOPEN, rawdata, i)) return rawdata[i + 2] === ">" ? i + 3 : bogusComment(i);
    const m = matchAt(LOCATETAGEND, rawdata, i + 2)!;
    const j = m.index + m[0].length;
    if (rawdata[j - 1] !== ">") return -1;
    h.endtag?.(pyLower(matchAt(TAGFIND, rawdata, i + 2)![1]));
    clearCdata();
    return j;
  };
  const parseComment = (i: number) => {
    const abrupt = matchAt(COMMENTABRUPTCLOSE, rawdata, i + 4);
    if (abrupt) return abrupt.index + abrupt[0].length;
    COMMENTCLOSE.lastIndex = i + 4;
    const m = COMMENTCLOSE.exec(rawdata);
    return m ? m.index + m[0].length : -1;
  };
  const parseDeclaration = (i: number) => {
    if (rawdata.startsWith("<!--", i)) return parseComment(i);
    if (rawdata.startsWith("<![CDATA[", i)) {
      const j = rawdata.indexOf("]]>", i + 9);
      return j < 0 ? -1 : j + 3;
    }
    if (pyLower(rawdata.slice(i, i + 9)) === "<!doctype") {
      const gt = rawdata.indexOf(">", i + 9);
      return gt === -1 ? -1 : gt + 1;
    }
    return bogusComment(i);
  };

  let i = 0;
  while (i < n) {
    let j: number;
    if (!cdataElem) {
      j = rawdata.indexOf("<", i);
      if (j < 0) {
        const amppos = rawdata.lastIndexOf("&");
        if (amppos >= Math.max(i, backFromEnd(rawdata, 34)) && !/[\t\n\r\f ;]/.test(rawdata.slice(amppos))) break;
        j = n;
      }
    } else {
      interesting!.lastIndex = i;
      const m = interesting!.exec(rawdata);
      if (!m) break;
      j = m.index;
    }
    if (i < j) data(escapable ? unescape(rawdata.slice(i, j)) : rawdata.slice(i, j));
    i = j;
    if (i === n) break;
    // Only '<' is interesting with convert_charrefs, so the '&' branches of goahead never run.
    let k: number;
    if (matchAt(STARTTAGOPEN, rawdata, i)) k = parseStarttag(i);
    else if (rawdata.startsWith("</", i)) k = parseEndtag(i);
    else if (rawdata.startsWith("<!--", i)) k = parseComment(i);
    else if (rawdata.startsWith("<?", i)) {
      const gt = rawdata.indexOf(">", i + 2);
      k = gt === -1 ? -1 : gt + 1;
    } else if (rawdata.startsWith("<!", i)) k = parseDeclaration(i);
    else if (i + 1 < n) {
      data("<");
      k = i + 1;
    } else break;
    if (k < 0) break;
    i = k;
  }
}

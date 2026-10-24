import { codePoints, PY_DECIMAL_CLASS, PY_SPACE_CLASS, PY_WORD_CLASS, pyIgnoreCaseClass, pyIsCased } from "./unicode";

// The re patterns the ported sources use, translated with CPython 3.13.15's str-pattern semantics:
// \b is a Unicode word boundary, and IGNORECASE also lets 'i', 'k' and 's' match 'İ', 'ı', 'K' and 'ſ'
// (JavaScript's /iu does not).

const escape = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** re.compile(r'\b(?:alt|...)\b', re.I) for alternatives that start and end with a word character. */
export function wordsIgnoreCase(alternatives: string[]): RegExp {
  const body = alternatives.map((alt) => [...alt].map((ch) => (/[A-Za-z]/.test(ch) ? `[${pyIgnoreCaseClass(ch)}]` : escape(ch))).join("")).join("|");
  return new RegExp(`(?<![${PY_WORD_CLASS}])(?:${body})(?![${PY_WORD_CLASS}])`, "u");
}

const W = `[${PY_WORD_CLASS}]`;
const BOUNDARY = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const CLASS_ESCAPES: Record<string, string> = { s: PY_SPACE_CLASS, d: PY_DECIMAL_CLASS, w: PY_WORD_CLASS };
const NEGATED: Record<string, string> = { S: "s", D: "d", W: "w" };

class Unsupported extends Error {}

/** One pattern character as a JS /u atom, case-folded the way sre does under IGNORECASE. */
function literal(ch: string, ignoreCase: boolean, inClass: boolean): string {
  if (ignoreCase && /^[A-Za-z]$/.test(ch)) return inClass ? pyIgnoreCaseClass(ch) : `[${pyIgnoreCaseClass(ch)}]`;
  if (ignoreCase && pyIsCased(ch.codePointAt(0)!)) throw new Unsupported(`IGNORECASE on ${ch}`);
  return /[\p{L}\p{N}\p{Z}]/u.test(ch) || ch.codePointAt(0)! > 0x7f ? ch : `\\u{${ch.codePointAt(0)!.toString(16)}}`;
}

/**
 * Translates the subset of Python re syntax the sources use: literals, groups, alternation, greedy
 * and lazy quantifiers, '.', '^', '$', character classes, and the \b \s \S \d \D \w \W escapes.
 * Anything else (backreferences, inline flags, letter ranges under IGNORECASE) throws, so a pattern
 * this cannot translate exactly fails at load instead of matching differently.
 */
export function translate(pattern: string, ignoreCase = false): string {
  const cps = codePoints(pattern).map((c) => String.fromCodePoint(c));
  let out = "";
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    if (ch === "\\") {
      const e = cps[++i];
      if (e === undefined) throw new Unsupported("trailing backslash");
      if (e === "b") out += BOUNDARY;
      else if (CLASS_ESCAPES[e]) out += `[${CLASS_ESCAPES[e]}]`;
      else if (NEGATED[e]) out += `[^${CLASS_ESCAPES[NEGATED[e]]}]`;
      else if (/[A-Za-z0-9]/.test(e)) throw new Unsupported(`\\${e}`);
      else out += literal(e, ignoreCase, false);
    } else if (ch === ".") out += "[^\\n]";
    else if (ch === "^") out += "^";
    else if (ch === "$") out += "(?=\\n?$)";
    else if (ch === "(") {
      if (cps[i + 1] === "?") {
        if (cps[i + 2] !== ":") throw new Unsupported("(?");
        out += "(?:";
        i += 2;
      } else out += "(";
    } else if (ch === ")" || ch === "|" || ch === "*" || ch === "+" || ch === "?") out += ch;
    else if (ch === "{") {
      const m = /^\{(\d*)(?:(,)(\d*))?\}/.exec(cps.slice(i).join(""));
      if (m && (m[1] || m[2])) {
        out += `{${m[1] || "0"}${m[2] ?? ""}${m[3] ?? ""}}`;
        i += m[0].length - 1;
      } else out += "\\{";
    } else if (ch === "[") {
      let j = i + 1, body = "";
      if (cps[j] === "^") body += "^", j++;
      if (cps[j] === "]") body += "\\]", j++;
      for (; j < cps.length && cps[j] !== "]"; j++) {
        const c = cps[j];
        if (c === "\\") {
          const e = cps[++j];
          if (CLASS_ESCAPES[e]) body += CLASS_ESCAPES[e];
          else if (/[A-Za-z0-9]/.test(e)) throw new Unsupported(`[\\${e}]`);
          else body += literal(e, ignoreCase, true);
        } else if (cps[j + 1] === "-" && cps[j + 2] !== undefined && cps[j + 2] !== "]") {
          if (ignoreCase && /[A-Za-z]/.test(c + cps[j + 2])) throw new Unsupported("letter range under IGNORECASE");
          body += `${literal(c, false, true)}-${literal(cps[j + 2], false, true)}`;
          j += 2;
        } else body += c === "-" ? "\\-" : literal(c, ignoreCase, true);
      }
      if (j >= cps.length) throw new Unsupported("unterminated class");
      out += `[${body}]`;
      i = j;
    } else if (ch === "]" || ch === "}") out += "\\" + ch;
    else out += literal(ch, ignoreCase, false);
  }
  return out;
}

/** re.compile(pattern, re.I if ignoreCase else 0), for search(), findall() and sub(). */
export const pyRe = (pattern: string, ignoreCase = false, global = false) => new RegExp(translate(pattern, ignoreCase), global ? "gu" : "u");

/** re.fullmatch(pattern, s): the match array, or null. */
export const pyFullmatch = (pattern: string, s: string, ignoreCase = false) =>
  new RegExp(`^(?:${translate(pattern, ignoreCase)})$`, "u").exec(s);

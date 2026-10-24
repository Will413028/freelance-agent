import { PY_WORD_CLASS, pyIgnoreCaseClass } from "./unicode";

// The re patterns the ported sources use, translated with CPython 3.13.15's str-pattern semantics:
// \b is a Unicode word boundary, and IGNORECASE also lets 'i', 'k' and 's' match 'İ', 'ı', 'K' and 'ſ'
// (JavaScript's /iu does not).

const escape = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** re.compile(r'\b(?:alt|...)\b', re.I) for alternatives that start and end with a word character. */
export function wordsIgnoreCase(alternatives: string[]): RegExp {
  const body = alternatives.map((alt) => [...alt].map((ch) => (/[A-Za-z]/.test(ch) ? `[${pyIgnoreCaseClass(ch)}]` : escape(ch))).join("")).join("|");
  return new RegExp(`(?<![${PY_WORD_CLASS}])(?:${body})(?![${PY_WORD_CLASS}])`, "u");
}

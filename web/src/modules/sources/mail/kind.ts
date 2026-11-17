// Word patterns for a listing's kind, read from mail titles. A word boundary is Python's (the old parsers
// ran under Python str semantics): letters and digits of every script are word characters, so 「師Contract」
// has no boundary between 師 and C, unlike JavaScript's ASCII-only \b.
const W = String.raw`[\p{L}\p{N}_]`;
/** A case-insensitive pattern where `\b` means a Unicode word boundary. */
export const wordsIgnoreCase = (pattern: string) => new RegExp(pattern.replaceAll(String.raw`\b`, `(?:(?<!${W})(?=${W})|(?<=${W})(?!${W}))`), "iu");

export const FULL_TIME = wordsIgnoreCase(String.raw`全職|\bfull[ -]time\b`);

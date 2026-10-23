// Spike 1c: reproduce Python's stored-data hashing byte for byte (synthetic-data spike, not product code).
// Runs on Node >= 22.18 / 23.6 with native type stripping: erasable TypeScript only.
import { createHash } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { readFileSync } from 'node:fs';

// Negative controls only (verify.ts --controls): each one swaps a rule for the naive JS behaviour.
const CONTROL = process.env.SPIKE_CONTROL ?? '';

// ---------------------------------------------------------------- Python value model
// JSON.parse loses int vs float (1 vs 1.0), ints above 2**53 and insertion order of
// integer-like keys, so values carry their Python type explicitly.
export type Py =
  | { t: 'n' } | { t: 'b'; v: boolean } | { t: 'i'; v: bigint } | { t: 'f'; v: number }
  | { t: 's'; v: string } | { t: 'l'; v: Py[] } | { t: 'o'; v: [string, Py][] };

export class PyError extends Error {
  pyType: string;
  constructor(pyType: string, message = pyType) { super(message); this.pyType = pyType; }
}

// ---------------------------------------------------------------- frozen Unicode tables
// Generated from the same CPython (unicodedata 15.1) by gen_expected.py; ICU in Node is newer.
type Tables = { unidata: string; unassigned: [number, number][]; nonprintable: [number, number][];
  space: [number, number][]; casefold: Record<string, string>; nfkc_single: Record<string, string> };
export const TABLES: Tables = JSON.parse(readFileSync(new URL('./unicode-tables.json', import.meta.url), 'utf8'));
const CASEFOLD = new Map(Object.entries(TABLES.casefold).map(([k, v]) => [Number(k), v]));
const SPACE = new Set<number>(TABLES.space.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)));
const inRanges = (r: [number, number][], cp: number): boolean => {
  let lo = 0, hi = r.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (cp < r[mid][0]) hi = mid - 1; else if (cp > r[mid][1]) lo = mid + 1; else return true; }
  return false;
};
export const isUnassigned = (cp: number) => inRanges(TABLES.unassigned, cp);
const isPrintable = (cp: number) => !inRanges(TABLES.nonprintable, cp);

// Code points the way CPython sees a str: a lone surrogate is one code point.
export function codePoints(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    out.push(cp);
    if (cp > 0xffff) i++;
  }
  return out;
}
const fromCps = (cps: number[]) => cps.map((c) => String.fromCodePoint(c)).join('');
export function cmpCodePoint(a: string, b: string): number {
  const x = codePoints(a), y = codePoints(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

// ---------------------------------------------------------------- float repr (CPython 'r' format)
export function floatRepr(x: number): string {
  if (CONTROL === 'js-float') return String(x);
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, expText] = Math.abs(x).toExponential().split('e'); // shortest round-trip digits, like repr
  const digits = mant.replace('.', '');
  const exp = Number(expText), decpt = exp + 1, sign = x < 0 ? '-' : '';
  if (decpt <= -4 || decpt > 16) {
    const m = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits;
    return sign + m + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  }
  if (decpt <= 0) return sign + '0.' + '0'.repeat(-decpt) + digits;
  if (decpt >= digits.length) return sign + digits + '0'.repeat(decpt - digits.length) + '.0';
  return sign + digits.slice(0, decpt) + '.' + digits.slice(decpt);
}

// ---------------------------------------------------------------- json.dumps
export type DumpsOptions = { sortKeys?: boolean; ensureAscii?: boolean; compact?: boolean; allowNan?: boolean };
const SHORT: Record<number, string> = { 0x22: '\\"', 0x5c: '\\\\', 0x0a: '\\n', 0x0d: '\\r', 0x09: '\\t', 0x08: '\\b', 0x0c: '\\f' };
const hex4 = (n: number) => n.toString(16).padStart(4, '0');

function encodeString(s: string, ensureAscii: boolean): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) { // UTF-16 units: Python's 😀 output is exactly the unit pair
    const u = s.charCodeAt(i);
    if (SHORT[u] !== undefined) out += SHORT[u];
    else if (u < 0x20 || (ensureAscii && u > 0x7e)) out += '\\u' + hex4(u);
    else out += s[i];
  }
  return out + '"';
}

export function dumps(v: Py, o: DumpsOptions = {}): string {
  const ensureAscii = o.ensureAscii ?? true, allowNan = o.allowNan ?? true;
  const wrong = CONTROL === 'wrong-separators';
  const itemSep = !!o.compact !== wrong ? ',' : ', ', keySep = !!o.compact !== wrong ? ':' : ': ';
  const go = (x: Py): string => {
    switch (x.t) {
      case 'n': return 'null';
      case 'b': return x.v ? 'true' : 'false';
      case 'i': return x.v.toString();
      case 'f':
        if (!Number.isFinite(x.v)) {
          if (!allowNan) throw new PyError('ValueError', 'Out of range float values are not JSON compliant');
          return Number.isNaN(x.v) ? 'NaN' : x.v > 0 ? 'Infinity' : '-Infinity';
        }
        return floatRepr(x.v);
      case 's': return encodeString(x.v, ensureAscii);
      case 'l': return '[' + x.v.map(go).join(itemSep) + ']';
      case 'o': {
        const entries = !o.sortKeys || CONTROL === 'no-sort' ? x.v
          : CONTROL === 'utf16-sort' ? [...x.v].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          : [...x.v].sort((a, b) => cmpCodePoint(a[0], b[0]));
        return '{' + entries.map(([k, val]) => encodeString(k, ensureAscii) + keySep + go(val)).join(itemSep) + '}';
      }
    }
  };
  return go(v);
}

// str.encode() is strict UTF-8: a lone surrogate raises instead of becoming U+FFFD.
export function utf8Strict(s: string): Buffer {
  if (!s.isWellFormed()) throw new PyError('UnicodeEncodeError');
  return Buffer.from(s, 'utf8');
}
export const sha256Hex = (s: string) => createHash('sha256').update(utf8Strict(s)).digest('hex');

// ---------------------------------------------------------------- json.loads (lossless)
export function loads(text: string): Py {
  if (CONTROL === 'json-parse') return fromJs(JSON.parse(text));
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const fail = (): never => { throw new PyError('JSONDecodeError'); };
  const value = (): Py => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; const entries: [string, Py][] = []; ws();
      if (text[i] === '}') { i++; return { t: 'o', v: entries }; }
      for (;;) {
        ws(); if (text[i] !== '"') fail();
        const k = str(); ws(); if (text[i++] !== ':') fail();
        const val = value(); const at = entries.findIndex((e) => e[0] === k);
        if (at >= 0) entries[at][1] = val; else entries.push([k, val]); // dict keeps first position, last value
        ws(); if (text[i] === ',') { i++; continue; } if (text[i] === '}') { i++; return { t: 'o', v: entries }; } fail();
      }
    }
    if (c === '[') {
      i++; const items: Py[] = []; ws();
      if (text[i] === ']') { i++; return { t: 'l', v: items }; }
      for (;;) {
        items.push(value()); ws();
        if (text[i] === ',') { i++; continue; } if (text[i] === ']') { i++; return { t: 'l', v: items }; } fail();
      }
    }
    if (c === '"') return { t: 's', v: str() };
    for (const [lit, val] of [['null', { t: 'n' }], ['true', { t: 'b', v: true }], ['false', { t: 'b', v: false }],
      ['NaN', { t: 'f', v: NaN }], ['Infinity', { t: 'f', v: Infinity }], ['-Infinity', { t: 'f', v: -Infinity }]] as [string, Py][]) {
      if (text.startsWith(lit, i)) { i += lit.length; return val; }
    }
    const m = /^(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/.exec(text.slice(i));
    if (!m) fail();
    i += m![0].length;
    return m![2] || m![3] ? { t: 'f', v: Number(m![0]) } : { t: 'i', v: BigInt(m![1]) };
  };
  const str = (): string => {
    i++; let out = '';
    for (;;) {
      const c = text[i++];
      if (c === undefined) fail();
      if (c === '"') return out;
      if (c === '\\') {
        const e = text[i++];
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e === 'u') { out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16)); i += 4; }
        else if (simple[e] !== undefined) out += simple[e];
        else fail();
      } else if (c.charCodeAt(0) < 0x20) fail(); // strict=True
      else out += c;
    }
  };
  const result = value(); ws();
  if (i !== text.length) fail();
  return result;
}

function fromJs(x: unknown): Py {
  if (x === null) return { t: 'n' };
  if (typeof x === 'boolean') return { t: 'b', v: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { t: 'i', v: BigInt(x) } : { t: 'f', v: x };
  if (typeof x === 'string') return { t: 's', v: x };
  if (Array.isArray(x)) return { t: 'l', v: x.map(fromJs) };
  return { t: 'o', v: Object.entries(x as object).map(([k, v]) => [k, fromJs(v)] as [string, Py]) };
}

// ---------------------------------------------------------------- Python str()/repr()
function reprStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const cp of codePoints(s)) {
    const ch = String.fromCodePoint(cp);
    if (ch === quote || ch === '\\') out += '\\' + ch;
    else if (cp === 9) out += '\\t';
    else if (cp === 10) out += '\\n';
    else if (cp === 13) out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp < 0x7f || isPrintable(cp)) out += ch;
    else if (cp <= 0xff) out += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp <= 0xffff) out += '\\u' + hex4(cp);
    else out += '\\U' + cp.toString(16).padStart(8, '0');
  }
  return out + quote;
}
export function pyRepr(v: Py): string {
  switch (v.t) {
    case 'n': return 'None';
    case 'b': return v.v ? 'True' : 'False';
    case 'i': return v.v.toString();
    case 'f': return floatRepr(v.v);
    case 's': return reprStr(v.v);
    case 'l': return '[' + v.v.map(pyRepr).join(', ') + ']';
    case 'o': return '{' + v.v.map(([k, x]) => reprStr(k) + ': ' + pyRepr(x)).join(', ') + '}';
  }
}
export const pyStr = (v: Py) => (v.t === 's' ? v.v : pyRepr(v));
export function truthy(v: Py | undefined): boolean {
  if (!v) return false;
  switch (v.t) {
    case 'n': return false;
    case 'b': return v.v;
    case 'i': return v.v !== 0n;
    case 'f': return v.v !== 0;
    case 's': case 'l': case 'o': return v.v.length > 0;
  }
}

// ---------------------------------------------------------------- unicode helpers frozen to CPython
// NFKC: Unicode stability keeps assigned characters stable, so only characters CPython considers
// unassigned can differ; pass them through untouched (they are starters to CPython).
export function nfkcPy(s: string): string {
  if (CONTROL === 'raw-nfkc') return s.normalize('NFKC');
  let out = '', seg = '';
  for (const cp of codePoints(s)) {
    if (isUnassigned(cp)) { out += seg.normalize('NFKC') + String.fromCodePoint(cp); seg = ''; }
    else seg += String.fromCodePoint(cp);
  }
  return out + seg.normalize('NFKC');
}
export const casefold = (s: string) => CONTROL === 'tolower' ? s.toLowerCase() : codePoints(s).map((cp) => CASEFOLD.get(cp) ?? String.fromCodePoint(cp)).join('');
export function pySplit(s: string): string[] {
  const out: string[] = []; let cur: number[] = [];
  for (const cp of codePoints(s)) {
    if (SPACE.has(cp)) { if (cur.length) out.push(fromCps(cur)); cur = []; } else cur.push(cp);
  }
  if (cur.length) out.push(fromCps(cur));
  return out;
}
export function pyStrip(s: string): string {
  const cps = codePoints(s); let a = 0, b = cps.length;
  while (a < b && SPACE.has(cps[a])) a++;
  while (b > a && SPACE.has(cps[b - 1])) b--;
  return fromCps(cps.slice(a, b));
}

// rules.py:56  ' '.join(unicodedata.normalize('NFKC', str(value or '')).casefold().split())
export function text(v: Py | undefined): string {
  const s = truthy(v) ? pyStr(v!) : '';
  return pySplit(casefold(nfkcPy(s))).join(' ');
}

// ---------------------------------------------------------------- urllib.parse.urlsplit / geturl (3.13)
const C0_OR_SPACE = (cp: number) => cp <= 0x20;
const SCHEME_CHARS = /^[A-Za-z0-9+\-.]$/;
type Split = { scheme: string; netloc: string; path: string; query: string; fragment: string };
export function urlsplit(input: string): Split {
  let url = input;
  let k = 0; while (k < url.length && C0_OR_SPACE(url.charCodeAt(k))) k++;
  url = url.slice(k).replace(/[\t\r\n]/g, '');
  let scheme = '', netloc = '', query = '', fragment = '';
  const i = url.indexOf(':');
  if (i > 0 && /^[A-Za-z]$/.test(url[0]) && [...url.slice(0, i)].every((c) => SCHEME_CHARS.test(c))) {
    scheme = url.slice(0, i).toLowerCase(); url = url.slice(i + 1);
  }
  if (url.startsWith('//')) {
    let delim = url.length;
    for (const c of '/?#') { const w = url.indexOf(c, 2); if (w >= 0) delim = Math.min(delim, w); }
    netloc = url.slice(2, delim); url = url.slice(delim);
    const open = netloc.includes('['), close = netloc.includes(']');
    if (open !== close) throw new PyError('ValueError', 'Invalid IPv6 URL');
    if (open && close) checkBracketedNetloc(netloc);
  }
  const h = url.indexOf('#'); if (h >= 0) { fragment = url.slice(h + 1); url = url.slice(0, h); }
  const q = url.indexOf('?'); if (q >= 0) { query = url.slice(q + 1); url = url.slice(0, q); }
  checkNetloc(netloc);
  return { scheme, netloc, path: url, query, fragment };
}
const rpartitionAt = (s: string) => { const j = s.lastIndexOf('@'); return j >= 0 ? [s.slice(0, j), true, s.slice(j + 1)] as const : ['', false, s] as const; };
function checkBracketedNetloc(netloc: string) {
  const hp = rpartitionAt(netloc)[2];
  const b = hp.indexOf('[');
  let host: string;
  if (b >= 0) {
    if (b > 0) throw new PyError('ValueError', 'Invalid IPv6 URL');
    const rest = hp.slice(b + 1), e = rest.indexOf(']');
    host = e >= 0 ? rest.slice(0, e) : rest;
    const port = e >= 0 ? rest.slice(e + 1) : '';
    if (port && !port.startsWith(':')) throw new PyError('ValueError', 'Invalid IPv6 URL');
  } else host = hp.split(':')[0];
  if (host.startsWith('v')) { if (!/^v[a-fA-F0-9]+\..+$/s.test(host)) throw new PyError('ValueError'); }
  else if (!isIPv6(host)) throw new PyError('ValueError'); // ipaddress: IPv4 in brackets also raises
}
function checkNetloc(netloc: string) {
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
  const n = netloc.replace(/[@:#?]/g, '');
  const n2 = nfkcPy(n);
  if (n === n2) return;
  for (const c of '/?#@:') if (n2.includes(c)) throw new PyError('ValueError');
}
function hostname(netloc: string): string | null {
  const hostinfo = rpartitionAt(netloc)[2];
  const b = hostinfo.indexOf('[');
  const host = b >= 0 ? hostinfo.slice(b + 1).split(']')[0] : hostinfo.split(':')[0];
  return host ? host : null; // only truthiness is used
}
function userinfo(netloc: string): { username: string | null; password: string | null } {
  const [info, has] = rpartitionAt(netloc);
  if (!has) return { username: null, password: null };
  const c = info.indexOf(':');
  return c >= 0 ? { username: info.slice(0, c), password: info.slice(c + 1) } : { username: info, password: null };
}
export function urlunsplit(p: Split): string {
  let url = p.path;
  if (p.netloc) { if (url && url[0] !== '/') url = '/' + url; url = '//' + p.netloc + url; }
  else if (url.startsWith('//')) url = '//' + url;
  else if (p.scheme && USES_NETLOC.has(p.scheme) && (!url || url[0] === '/')) url = '//' + url;
  if (p.scheme) url = p.scheme + ':' + url;
  if (p.query) url += '?' + p.query;
  if (p.fragment) url += '#' + p.fragment;
  return url;
}
const USES_NETLOC = new Set(['', 'ftp', 'http', 'gopher', 'nntp', 'telnet', 'imap', 'wais', 'file', 'mms', 'https', 'shttp',
  'snews', 'prospero', 'rtsp', 'rtsps', 'rtspu', 'rsync', 'svn', 'svn+ssh', 'sftp', 'nfs', 'git', 'git+ssh', 'ws', 'wss', 'itms-services']);

// ---------------------------------------------------------------- hash points
export const get = (o: Py, k: string): Py | undefined => (o.t === 'o' ? o.v.find((e) => e[0] === k)?.[1] : undefined);
const S = (v: string): Py => ({ t: 's', v });
const L = (v: Py[]): Py => ({ t: 'l', v });
const without = (o: Py, keys: string[]): Py => {
  if (o.t !== 'o') throw new PyError('AttributeError');
  return { t: 'o', v: o.v.filter(([k]) => !keys.includes(k)) };
};
export const EXCLUDED = ['received_at', 'receipt_id', 'evidence_ref', 'raw_evidence_ref'];

/** HP1: identity_hash / rules._hash / legacy _hash / ensure_ascii=False receipts. */
export const sortedDumps = (v: Py) => dumps(v, { sortKeys: true, ensureAscii: false });
export const identityHash = (v: Py) => sha256Hex(sortedDumps(v));
/** HP3: json.dumps(job, sort_keys=True) — ensure_ascii left at its True default. */
export const asciiDumps = (v: Py) => dumps(v, { sortKeys: true, ensureAscii: true });
/** HP4: submissions.domain.digest. */
export const submissionDumps = (v: Py) => dumps(v, { sortKeys: true, ensureAscii: false, compact: true, allowNan: false });
export const submissionDigest = (v: Py) => sha256Hex(submissionDumps(v));
/** HP10: platform.sqlite.encode — insertion order, default separators. */
export const storageEncode = (v: Py) => dumps(v, { ensureAscii: false });

export function requireKey(o: Py, k: string): Py {
  if (o.t !== 'o') throw new PyError('AttributeError');
  const v = get(o, k); if (v === undefined) throw new PyError('KeyError'); return v;
}
export function opportunityIdAndFingerprint(job: Py) {
  return { id: identityHash(L([requireKey(job, 'source'), requireKey(job, 'external_id')])), fingerprint: identityHash(without(job, EXCLUDED)) };
}

/** HP5: rules.identity_keys */
export function identityKeys(job: Py): string[] {
  const keys = new Set<string>();
  const u = truthy(get(job, 'canonical_url')) ? get(job, 'canonical_url') : get(job, 'url');
  if (u && u.t === 's') {
    try {
      const p = urlsplit(u.v);
      const ui = userinfo(p.netloc);
      if (p.scheme === 'https' && hostname(p.netloc) && !ui.username && !ui.password) keys.add('url:' + urlunsplit({ ...p, fragment: '' }));
    } catch (e) { if (!(e instanceof PyError)) throw e; }
  }
  const company = text(get(job, 'company')), title = text(get(job, 'title')), body = text(get(job, 'description'));
  const bodyAvailable = get(job, 'body_available');
  if (company && title && (CONTROL === 'utf16-length' ? body.length : codePoints(body).length) >= 80 && !(bodyAvailable?.t === 'b' && bodyAvailable.v === false)) {
    const loc = truthy(get(job, 'location_evidence')) ? get(job, 'location_evidence') : get(job, 'location');
    keys.add('content:' + identityHash(L([S(company), S(title), S(body), get(job, 'kind') ?? { t: 'n' }, S(text(loc))])));
  }
  return [...keys].sort(cmpCodePoint);
}

/** HP6: rules.novelty for an item without stored novelty_keys. */
const NOVELTY_FIELDS = ['title', 'description', 'company', 'kind', 'currency', 'budget_min', 'budget_max', 'weekly_hours',
  'taiwan_eligible', 'timezone_compatible', 'deadline', 'listing_closed', 'compensation_evidence'];
export function novelty(id: string, fingerprint: string, job: Py, conflictFps: string[] = []): [string, string][] {
  const content: Py = { t: 'o', v: NOVELTY_FIELDS.map((k) => [k, get(job, k) ?? { t: 'n' }]) };
  const fp = identityHash(content);
  const pairs = new Map<string, [string, string]>();
  const add = (a: string, b: string) => pairs.set(JSON.stringify([a, b]), [a, b]);
  add(id, fingerprint); for (const c of conflictFps) add(id, c);
  for (const k of identityKeys(job)) add(k, fp);
  return [...pairs.values()].sort((x, y) => cmpCodePoint(x[0], y[0]) || cmpCodePoint(x[1], y[1]));
}

/** HP7: rules.group_items member token. */
export function memberToken(fingerprint: string, revision: number | null, conflictFps: string[], applicationToken: string[] | null): string {
  let t = fingerprint + ':' + String(revision ?? 0);
  if (conflictFps.length) t += ':' + identityHash(L([...conflictFps].sort(cmpCodePoint).map(S)));
  if (applicationToken && applicationToken.length) t += ':applications:' + identityHash(L(applicationToken.map(S)));
  return t;
}

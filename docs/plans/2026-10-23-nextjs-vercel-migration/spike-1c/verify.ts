// Spike 1c runner: compares canonical-json.ts with expected.json (Python ground truth).
//   node docs/plans/2026-10-23-nextjs-vercel-migration/spike-1c/verify.ts
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import * as C from './canonical-json.ts';
import type { Py } from './canonical-json.ts';

type Tagged = ['n'] | ['b', boolean] | ['i', string] | ['f', string] | ['s', string] | ['l', Tagged[]] | ['o', [string, Tagged][]];
const untag = (t: Tagged): Py => {
  switch (t[0]) {
    case 'n': return { t: 'n' };
    case 'b': return { t: 'b', v: t[1] };
    case 'i': return { t: 'i', v: BigInt(t[1]) };
    case 'f': return { t: 'f', v: t[1] === 'nan' ? NaN : t[1] === 'inf' ? Infinity : t[1] === '-inf' ? -Infinity : Number(t[1]) };
    case 's': return { t: 's', v: t[1] };
    case 'l': return { t: 'l', v: t[1].map(untag) };
    case 'o': return { t: 'o', v: t[1].map(([k, v]) => [k, untag(v)] as [string, Py]) };
  }
};
const str = (v: Py) => (v.t === 's' ? v.v : (() => { throw new C.PyError('TypeError'); })());

const hash = C.sha256Hex;
const IMPL: Record<string, (c: any) => unknown> = {
  'HP1.identity_hash': (c) => { const v = untag(c.input); return { sha256: C.identityHash(v), text: C.sortedDumps(v) }; },
  'HP1b.rules._hash': (c) => ({ sha256: C.identityHash(untag(c.input)) }),
  'HP1c.legacy_postgres._hash': (c) => ({ sha256: C.identityHash(untag(c.input)) }),
  'HP1d.opportunity_id_and_fingerprint': (c) => C.opportunityIdAndFingerprint(untag(c.input)),
  'HP1e.identity_hash_from_stored_text': (c) => ({ sha256: C.identityHash(C.loads(c.stored)) }),
  'HP2.receipt_ensure_ascii_false': (c) => {
    const j = untag(c.input), h = C.identityHash(j);
    const noRx = C.identityHash({ t: 'o', v: (j.t === 'o' ? j.v : []).filter(([k]) => k !== 'received_at') });
    const ext = C.pyStr(C.requireKey(j, 'external_id'));
    const content = C.identityHash({ t: 'o', v: (j as any).v.filter(([k]: [string]) => !C.EXCLUDED.includes(k)) });
    return { plain: 'guru:' + h, getonboard: 'getonboard:' + ext + ':' + h, public_feeds_int_identity: 'remotive:' + C.pyStr({ t: 'i', v: 12345n }) + ':' + h,
      taiwanjobs: 'taiwanjobs:' + noRx, ptt_codejob: 'ptt_codejob:' + content, ptt_soho: 'ptt_soho:' + content };
  },
  'HP3.receipt_ensure_ascii_true': (c) => {
    const s = C.asciiDumps(untag(c.input)), h = hash(s);
    return { text: s, himalayas: 'himalayas:' + h, linkedin: 'linkedin:' + h,
      free_jobs_float_id: 'weworkremotely:' + C.pyStr({ t: 'f', v: 7 }) + ':' + h, community: 'hn:' + h };
  },
  'HP4.submission_digest': (c) => { const v = untag(c.input); return { sha256: C.submissionDigest(v), text: C.submissionDumps(v) }; },
  'HP4b.submission_digest_from_stored_text': (c) => ({ sha256: C.submissionDigest(C.loads(c.stored)) }),
  'HP5.identity_keys': (c) => ({ keys: C.identityKeys(untag(c.input)) }),
  'HP6.novelty': (c) => ({ novelty: C.novelty('opp-1', 'f'.repeat(64), untag(c.input)) }),
  'HP7.group_token': (c) => {
    const tokens: Record<string, string> = {};
    c.input.forEach((s: any, n: number) => { tokens['id-' + n] = C.memberToken(s.fp, s.rev, s.conflicts, s.app); });
    return { tokens };
  },
  'HP8.legacy_review_key': (c) => {
    const j = untag(c.input);
    return { key: hash(C.dumps({ t: 'l', v: [C.requireKey(j, 'source'), C.requireKey(j, 'external_id')] })).slice(0, 24) };
  },
  'HP9.plain_str_sha256': (c) => {
    const s = str(untag(c.input));
    return { sha256: hash(s), intent_key: hash(s), suffix: hash(C.casefold(C.pyStrip(s))).slice(0, 12) };
  },
  'HP10.sqlite_encode': (c) => ({ text: C.storageEncode(untag(c.input)) }),
};

const expected = JSON.parse(readFileSync(new URL('./expected.json', import.meta.url), 'utf8'));
let total = 0, pass = 0;
const lines: string[] = [];
for (const point of expected.points) {
  const fn = IMPL[point.name];
  let ok = 0; const fails: string[] = [];
  for (const [n, c] of point.cases.entries()) {
    let got: { ok?: unknown; error?: string };
    try { got = { ok: fn(c) }; } catch (e) { got = { error: e instanceof C.PyError ? e.pyType : 'JS:' + (e as Error).message }; }
    const match = 'error' in c.expect ? 'error' in got : isDeepStrictEqual(got.ok, c.expect.ok);
    if (match) ok++; else fails.push(`  case ${n}: input=${JSON.stringify(c.input ?? c.stored).slice(0, 160)}\n    want=${JSON.stringify(c.expect).slice(0, 300)}\n    got =${JSON.stringify(got).slice(0, 300)}`);
  }
  total += point.cases.length; pass += ok;
  lines.push(`${ok === point.cases.length ? 'PASS' : 'FAIL'} ${point.name}: ${ok}/${point.cases.length}`);
  lines.push(...fails);
}

// Unicode drift diagnostics: why the TS side uses CPython-frozen tables.
const T = C.TABLES;
let nfkcAssigned = 0, nfkcUnassigned = 0; const nfkcExamples: string[] = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const ch = String.fromCodePoint(cp), want = T.nfkc_single[cp] ?? ch, js = ch.normalize('NFKC');
  if (js !== want) { if (C.isUnassigned(cp)) nfkcUnassigned++; else { nfkcAssigned++; nfkcExamples.push(cp.toString(16)); } }
}
let lowerDiff = 0, frozenNfkcDiff = 0;
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const ch = String.fromCodePoint(cp);
  if (ch.toLowerCase() !== (T.casefold[cp] ?? ch)) lowerDiff++;
  if (C.nfkcPy(ch) !== (T.nfkc_single[cp] ?? ch)) frozenNfkcDiff++;
}
let spaceDiff = 0;
const pySpace = new Set<number>(); for (const [a, b] of T.space) for (let x = a; x <= b; x++) pySpace.add(x);
for (let cp = 0; cp <= 0xffff; cp++) if (/\s/.test(String.fromCharCode(cp)) !== pySpace.has(cp)) spaceDiff++;

console.log(`python ${expected.python.split(' ')[0]} unidata ${expected.unidata}; node ${process.version} icu-unicode ${process.versions.unicode}`);
console.log(lines.join('\n'));
console.log(`TOTAL ${pass}/${total}`);
console.log(`diag: raw String.normalize('NFKC') differs from CPython on ${nfkcUnassigned} code points CPython treats as unassigned, ${nfkcAssigned} assigned${nfkcExamples.length ? ' (' + nfkcExamples.slice(0, 10).join(',') + ')' : ''}`);
console.log(`diag: nfkcPy() (unassigned pass-through) differs from CPython single-code-point NFKC on ${frozenNfkcDiff} code points`);
console.log(`diag: toLowerCase() differs from str.casefold() on ${lowerDiff} code points (TS uses the frozen table)`);
console.log(`diag: JS /\\s/ differs from str.isspace() on ${spaceDiff} BMP code points (TS uses the frozen table)`);
process.exitCode = pass === total ? 0 : 1;

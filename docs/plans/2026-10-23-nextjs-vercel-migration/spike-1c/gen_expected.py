"""Spike 1c: emit Python ground truth for every persisted hash point.

Synthetic data only. Run from the repository root:
    backend/.venv/bin/python -I docs/plans/2026-10-23-nextjs-vercel-migration/spike-1c/gen_expected.py
Writes expected.json and unicode-tables.json next to this file.
"""
from hashlib import sha256
from pathlib import Path
import json
import sys
import unicodedata

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / 'backend' / 'src'))

from freelance.modules.collection.store import identity_hash          # noqa: E402  store.py:10
from freelance.modules.discovery import rules                          # noqa: E402  rules.py:60
from freelance.modules.submissions.domain import digest                # noqa: E402  domain.py:12
from freelance.platform.sqlite import encode                           # noqa: E402  sqlite.py:12
from freelance.modules.collection import ptt_codejob, ptt_soho         # noqa: E402


def tag(v):
    """Type-preserving transport: JSON alone would lose int/float and key order."""
    if v is None:
        return ['n']
    if v is True or v is False:
        return ['b', v]
    if isinstance(v, int):
        return ['i', str(v)]
    if isinstance(v, float):
        return ['f', repr(v)]
    if isinstance(v, str):
        return ['s', v]
    if isinstance(v, list):
        return ['l', [tag(x) for x in v]]
    if isinstance(v, dict):
        return ['o', [[k, tag(x)] for k, x in v.items()]]
    raise TypeError(type(v))


def attempt(fn):
    try:
        return {'ok': fn()}
    except Exception as exc:  # the TS side must fail the same way
        return {'error': type(exc).__name__}


def ser_then_hash(dumps_kwargs):
    def run(v):
        s = json.dumps(v, **dumps_kwargs)
        return {'text': s, 'sha256': sha256(s.encode()).hexdigest()}
    return run

# ---------------------------------------------------------------- corpus
STRINGS = [
    'plain ascii', '', '中文職缺 台北 遠端', '𝔘😀', 'é vs é', ' nbsp ',
    'ctrl\x00\x01\x1f\x7f\x80\x9f', 'line para ', 'q"b\\s/', '\b\f\n\r\t',
    '﻿bom', '\U0010ffff', 'ß ẞ', 'ΑΣ ς', 'ﬁ ＡＢＣ １２３ ｶﾞ', "it's", 'say "hi" it\'s',
    '​zero‍width', 'emoji 👩‍💻 flag 🇹🇼', '\x85nel\x1cfs', 'Ꭰꭰ', '\U0001ccd6',
    'Ɤ', '　全形空白　',
]
LONE = ['\ud800', 'a\udfffb']
INTS = [0, -1, 7, 2**31, 2**53, 2**53 + 1, -(2**63), 10**21, 10**30]
FLOATS = [0.1, 1.0, -0.0, 0.0, 1e21, 1e22, 1e16, 1e15, 9007199254740993.0, 123456789012345.6,
          1e-7, 1e-5, 0.0001, 0.00001234, 5e-324, 1.7976931348623157e308, 1500.0, 2.5,
          -3.75e-10, 1/3, 100.0, 1e100]
NONFINITE = [float('nan'), float('inf'), float('-inf')]
SCALARS = [None, True, False]
CONTAINERS = [
    [], {}, [[]], {'a': {}}, [1, 1.0, '1', True, None],
    {'｡': 1, '😀': 2, 'a': 3, 'B': 4, 'é': 5, '中': 6, '𝔘': 7, '': 8, '10': 9, '2': 10, '1': 11, '｡｡': 12},
    {'z': [{'y': {'x': [1.5, {'w': None}]}}], 'a': {'c': 'δ', 'b': '😀'}},
    {'\U0001f600a': 1, 'ﬁ': 2, '￿': 3, '\U00010000': 4},
]
JOBS = [
    dict(source='ptt_codejob', external_id='M.1700000000.A.123', title='徵 Python 後端 😀', company='某公司',
         description='遠端可，時薪 NT$800；每週 10 小時\n聯絡：站內信', kind='contract', currency='TWD',
         budget_min=800, budget_max=1200.0, weekly_hours=10, taiwan_eligible=True, timezone_compatible=None,
         deadline=None, listing_closed=False, url='https://www.ptt.cc/bbs/CodeJob/M.1700000000.A.123.html',
         received_at='2026-10-01T01:02:03+00:00', evidence_ref='msg:abc', raw_evidence_ref='raw:abc'),
    dict(source='himalayas', external_id='remote-𝔘', title='Senior Engineer', company='Acme Inc',
         description='x' * 90, kind='employment', location_evidence=['Taiwan', 'Remote'],
         timezone_evidence=['+08:00'], weekly_hours=None, budget_min=None, budget_max=None, salary_evidence={'min': 1e5, 'max': None},
         language='en', complete=False, receipt_id='old', url='https://Himalayas.app/jobs/a b?ref=x#frag'),
    dict(source='nodesk', external_id='42', title='ΑΣ Designer', company='Straße GmbH', description='Ꭰꭰ ' * 40,
         kind='freelance', location_evidence={'@type': 'Country', 'name': "Taiwan's  "}, budget_min=-0.0,
         budget_max=1e21, weekly_hours=0.5, url='https://user@evil.example/x'),
]
CORPUS = STRINGS + INTS + FLOATS + SCALARS + CONTAINERS + JOBS


def cases_for(name, fn, inputs, note):
    return {'name': name, 'note': note,
            'cases': [{'input': tag(v), 'expect': attempt(lambda v=v: fn(v))} for v in inputs]}

points = []
EXCL = {'received_at', 'receipt_id', 'evidence_ref', 'raw_evidence_ref'}

# HP1 identity_hash (default separators, sort_keys, ensure_ascii=False); same args as rules._hash,
# legacy/postgres._hash, legacy/review.py:34 and the ensure_ascii=False connector receipts.
points.append(cases_for('HP1.identity_hash', lambda v: {'sha256': identity_hash(v),
                        'text': json.dumps(v, sort_keys=True, ensure_ascii=False)},
                        CORPUS + NONFINITE + LONE, 'real collection.store.identity_hash'))
points.append(cases_for('HP1b.rules._hash', lambda v: {'sha256': rules._hash(v)}, CORPUS + NONFINITE,
                        'real discovery.rules._hash'))
points.append(cases_for('HP1c.legacy_postgres._hash',
                        lambda v: {'sha256': sha256(json.dumps(v, sort_keys=True, ensure_ascii=False).encode()).hexdigest()},
                        CORPUS, 'replicates legacy/postgres.py:20 (module needs psycopg, not installed)'))
points.append(cases_for('HP1d.opportunity_id_and_fingerprint',
                        lambda j: {'id': identity_hash([j['source'], j['external_id']]),
                                   'fingerprint': identity_hash({k: v for k, v in j.items() if k not in EXCL})},
                        JOBS, 'store.py:64-65 composition with real identity_hash'))

# HP2 ensure_ascii=False receipts with prefixes (connector lines quoted in hash-points.md)
def receipts_a(j):
    h = sha256(json.dumps(j, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    no_rx = sha256(json.dumps({k: v for k, v in j.items() if k != 'received_at'}, sort_keys=True,
                              ensure_ascii=False).encode()).hexdigest()
    return {'plain': 'guru:' + h, 'getonboard': 'getonboard:' + str(j['external_id']) + ':' + h,
            'public_feeds_int_identity': 'remotive:' + str(12345) + ':' + h,
            'taiwanjobs': 'taiwanjobs:' + no_rx,
            'ptt_codejob': ptt_codejob.receipt(j)['receipt_id'], 'ptt_soho': ptt_soho.receipt(j)['receipt_id']}
points.append(cases_for('HP2.receipt_ensure_ascii_false', receipts_a, JOBS + CONTAINERS[4:] ,
                        'ptt_* via real receipt(); others replicate the quoted one-liners'))

# HP3 ensure_ascii=True receipts (himalayas, linkedin_mail, free_jobs, community_jobs)
def receipts_b(j):
    s = json.dumps(j, sort_keys=True)
    h = sha256(s.encode()).hexdigest()
    return {'text': s, 'himalayas': 'himalayas:' + h, 'linkedin': 'linkedin:' + h,
            'free_jobs_float_id': 'weworkremotely:' + str(7.0) + ':' + h, 'community': 'hn:' + h}
points.append(cases_for('HP3.receipt_ensure_ascii_true', receipts_b, CORPUS + LONE + NONFINITE,
                        'replicates json.dumps(job, sort_keys=True); ensure_ascii default True'))

# HP4 submission digest: compact, allow_nan=False; also recomputed from stored text (store.py:54,66)
points.append(cases_for('HP4.submission_digest', lambda v: {'sha256': digest(v),
                        'text': json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)},
                        CORPUS + NONFINITE + LONE, 'real submissions.domain.digest'))
points.append({'name': 'HP4b.submission_digest_from_stored_text',
               'note': 'digest(json.loads(encode(v))) — TS must parse stored text losslessly',
               'cases': [{'stored': encode(v), 'expect': attempt(lambda v=v: {'sha256': digest(json.loads(encode(v)))})}
                         for v in CORPUS]})
points.append({'name': 'HP1e.identity_hash_from_stored_text',
               'note': 'novelty() rehashes jobs read back from opportunities.item text',
               'cases': [{'stored': encode(v), 'expect': attempt(lambda v=v: {'sha256': identity_hash(json.loads(encode(v)))})}
                         for v in CORPUS + NONFINITE]})

# HP5 identity_keys: url key (urlsplit) + content key (_hash over text()-normalized fields)
def ik(j):
    return {'keys': sorted(rules.identity_keys(j))}
body = 'Remote contract, Python backend work, flexible hours, async team across Asia time zones. '
URLS = ['https://Example.COM/a b?q=1#frag', 'https://例子.tw/路徑?x=中', 'https://x.com', 'https://x.com/?', 'https://x.com/#',
        'HTTPS://x.com/p', ' \x01https://x.com/p\t\n', 'https://user:pw@x.com/', 'https://@x.com/a', 'https://[::1]:8080/a',
        'https://[1.2.3.4]/', 'https://[v1.fe]/', 'https://a]b/', 'http://x.com/', 'https:///nohost', 'https://:80/',
        'https://x.com/a#b#c', 'https://x.com/a?b?c', 'https://℀.com/', 'https://ｘ.com/', None, 42, 'https://x.com/p ']
VALUES = ['', 'Acme', 'Straße ΑΣ', 'ﬁ Café́', '  multiple\t\nspaces\x1c\x1d\x85　x ', '﻿bom', 'Ꭰꭰ',
          '\U0001ccd6Ɤ', 0, 7, 1.0, False, True, None, ['Taiwan', "it's", ' ', '中'],
          {'@type': 'Country', 'name': 'Taiwan', 'n': 1.5, 'x': None}, [{'a': '\x00​\U000e0001'}], ('t',)]
IK_JOBS = [dict(url=u) for u in URLS] + [dict(canonical_url='https://c.example/x', url='https://u.example/y')]
for i, v in enumerate(VALUES):
    IK_JOBS.append(dict(company=v if i % 3 else 'Co', title=v if i % 3 != 1 else 'T', description=body + str(v),
                        kind=v if i % 2 else 'contract', location_evidence=v, location='fallback'))
    IK_JOBS.append(dict(company='Co ' + str(i), title='T', description=body, kind=None, location=v))
IK_JOBS.append(dict(company='Co', title='T', description=body, body_available=False))
IK_JOBS.append(dict(company='Co', title='T', description='short'))
IK_JOBS.append(dict(company='Co', title='T', description='😀' * 79))   # 79 code points, 158 UTF-16 units
IK_JOBS.append(dict(company='Co', title='T', description='😀' * 80))
IK_JOBS = [j for j in IK_JOBS if not any(isinstance(x, tuple) for x in j.values())]  # tuples never come from JSON
points.append(cases_for('HP5.identity_keys', ik, IK_JOBS, 'real discovery.rules.identity_keys'))

# HP6 novelty set (stored in digest_outbox.snapshot.items[].novelty_keys)
def nov(j):
    return {'novelty': sorted([list(t) for t in rules.novelty({'id': 'opp-1', 'fingerprint': 'f' * 64, 'job': j})])}
points.append(cases_for('HP6.novelty', nov, JOBS + IK_JOBS[-20:], 'real discovery.rules.novelty'))

# HP7 group member token (stored in proposal_drafts.source_tokens and submission snapshot)
def tok(spec):
    items = []
    for n, s in enumerate(spec):
        conflicts = ([{'versions': [{'fingerprint': fp, 'evaluation': {'status': 'qualified'}} for fp in s['conflicts']]}]
                     if s['conflicts'] else [])
        item = {'id': f'id-{n}', 'fingerprint': s['fp'], 'job': {'source': 's', 'title': f't{n}'},
                'evaluation': {'status': 'qualified', 'score': 0}, 'review_status': 'draft',
                'recommendation': {'basis_fingerprint': s['fp'], 'score': 0}, 'content_conflicts': conflicts}
        if s['rev'] is not None:
            item['tracking'] = {'revision': s['rev']}
        if s['app'] is not None:
            item['application_token'] = s['app']
        items.append(item)
    out = {}
    for g in rules.group_items(items):
        for m in g['members']:
            out[m['id']] = m['token']
    return {'tokens': out}
TOKEN_SPECS = [[{'fp': 'a' * 64, 'rev': None, 'conflicts': [], 'app': None}],
               [{'fp': 'b' * 64, 'rev': 3, 'conflicts': ['c' * 64, '0' * 64], 'app': None}],
               [{'fp': 'd' * 64, 'rev': 12, 'conflicts': [], 'app': ['u-1:2:', 'u-0:5:2026-10-01T00:00:00+00:00']}],
               [{'fp': 'e' * 64, 'rev': 1, 'conflicts': ['9' * 64], 'app': ['x:1:']}],
               [{'fp': 'f' * 64, 'rev': 0, 'conflicts': [], 'app': []}]]
points.append({'name': 'HP7.group_token', 'note': 'real discovery.rules.group_items',
               'cases': [{'input': s, 'expect': attempt(lambda s=s: tok(s))} for s in TOKEN_SPECS]})

# HP8 legacy review key: json.dumps([source, external_id]) ensure_ascii=True, unsorted, truncated 24
points.append(cases_for('HP8.legacy_review_key',
                        lambda j: {'key': sha256(json.dumps([j['source'], j['external_id']]).encode()).hexdigest()[:24]},
                        JOBS, 'replicates legacy/review.py:32'))

# HP9 sha256 over plain str (legacy approved_hash; transient intent keys and file suffix)
points.append(cases_for('HP9.plain_str_sha256', lambda s: {'sha256': sha256(s.encode()).hexdigest(),
                        'intent_key': sha256(str(s).encode()).hexdigest(),
                        'suffix': sha256(s.strip().casefold().encode()).hexdigest()[:12]},
                        STRINGS + LONE, 'approved_hash=sha256(proposal.encode()); daily.py:35 suffix'))

# HP10 storage encode (insertion order, default separators, ensure_ascii=False); bytes persisted, not hashed
points.append(cases_for('HP10.sqlite_encode', lambda v: {'text': encode(v)}, CORPUS + NONFINITE + LONE,
                        'real platform.sqlite.encode'))

(HERE / 'expected.json').write_text(json.dumps({'python': sys.version, 'unidata': unicodedata.unidata_version,
                                                 'points': points}, ensure_ascii=True, indent=1) + '\n')

# ---------------------------------------------------------------- frozen Unicode tables from this Python
def ranges(pred):
    out, start = [], None
    for cp in range(0x110000 + 1):
        hit = cp <= 0x10FFFF and pred(chr(cp))
        if hit and start is None:
            start = cp
        elif not hit and start is not None:
            out.append([start, cp - 1]); start = None
    return out
casefold = {cp: chr(cp).casefold() for cp in range(0x110000) if chr(cp).casefold() != chr(cp)}
nfkc = {cp: unicodedata.normalize('NFKC', chr(cp)) for cp in range(0x110000)
        if not 0xD800 <= cp <= 0xDFFF and unicodedata.normalize('NFKC', chr(cp)) != chr(cp)}
tables = {'unidata': unicodedata.unidata_version,
          'unassigned': ranges(lambda c: unicodedata.category(c) == 'Cn'),
          'nonprintable': ranges(lambda c: not c.isprintable()),
          'space': ranges(lambda c: c.isspace()),
          'casefold': {str(k): v for k, v in casefold.items()},
          'nfkc_single': {str(k): v for k, v in nfkc.items()}}
(HERE / 'unicode-tables.json').write_text(json.dumps(tables, ensure_ascii=True) + '\n')
print(json.dumps({p['name']: len(p['cases']) for p in points}, indent=1))

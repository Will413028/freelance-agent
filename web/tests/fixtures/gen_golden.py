"""Python ground truth for the TS port of the shared layer (migration plan step 4b).

Synthetic data only; no runtime files, credentials or network. Run from the repository root:
    backend/.venv/bin/python -I -B web/tests/fixtures/gen_golden.py
Writes golden.json next to this file. Values travel tagged (see tag()) because plain JSON would lose
int vs float and key order; structured outputs are compared as platform.sqlite.encode() text, which is
exactly what the Python writer stores.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / 'backend' / 'src'))

from freelance.bootstrap.store import SQLiteStore                      # noqa: E402
from freelance.modules.discovery import domain, rules, ranking         # noqa: E402
from freelance.modules.collection.store import identity_hash           # noqa: E402
from freelance.platform.sqlite import encode                           # noqa: E402
from freelance.modules.collection import free_jobs                     # noqa: E402
from freelance.modules.collection import cryptojobslist, public_feeds   # noqa: E402
from email.utils import parsedate_to_datetime                          # noqa: E402

# free_jobs parses HTML with html.parser, whose behaviour changes between patch releases (3.13.13
# closes '<!-->' differently). The ground truth is the production image's interpreter.
PRODUCTION_PYTHON = (3, 13, 15)
if sys.version_info[:3] != PRODUCTION_PYTHON:
    sys.exit(f'gen_golden.py needs Python {PRODUCTION_PYTHON} (the production image), not {sys.version_info[:3]}')


def tag(v):
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
    if isinstance(v, (list, tuple)):
        return ['l', [tag(x) for x in v]]
    if isinstance(v, dict):
        return ['o', [[k, tag(x)] for k, x in v.items()]]
    raise TypeError(type(v))


def attempt(fn):
    try:
        return {'ok': fn()}
    except Exception as exc:  # the TS side must fail the same way
        return {'error': type(exc).__name__}


NOW = datetime(2026, 9, 28, 1, tzinfo=timezone.utc)


def job(**changes):
    """tests/fixtures/domain.py:job"""
    base = dict(source="freelancer", external_id="101", title="AI agent workflow",
                description="Build an agent with tool calling and API integration.",
                url="https://www.freelancer.com/projects/example-101", kind="fixed",
                currency="TWD", budget_min=4000, budget_max=8000,
                weekly_hours=10, taiwan_eligible=True, timezone_compatible=True,
                deadline="2099-01-01", language="en", complete=True)
    if 'external_id' in changes and 'url' not in changes:
        base['url'] = 'https://www.freelancer.com/projects/example-' + str(changes['external_id'])
    return base | changes


# ---------------------------------------------------------------- scalar corpora
ISO = [
    '2026-10-24T07:50:03.+00:00', '2026-10-24T07:50:03.', '2026-10-24T07.+00:00', '2026-10-24T07:50,+08', '2099-01-01', '2026-09-16', '2026-09-17T08:00:00Z', '2026-09-17 08:00:00', '2026-09-17T08:00:00+08:00',
    '20260917', '2026-W38-4', '2026W384', '2026-W38', '2026W38', '2026-09-17T08', '2026-09-17T0800',
    '2026-09-17T080000', '2026-09-17T08:00:00.5+00:00', '2026-09-17T08:00:00,123456789+05:30',
    '2026-09-17T08:00:00.1234567', '2026-13-01', '2026-02-30', '2024-02-29', 'not a date', '', '2026-09-1',
    '2026-09-17T24:00:00', '2026-09-17T23:59:60', '2026-09-17T08:00:00+24:00', '2026-09-17T08:00:00-23:59:59.999999',
    '2026-09-17　08:00', '２０２６-09-17', '2026-09-17T08:00:00+00:00 extra',
    '2026-09-17T10:00:00:12', '2026-09-17T08:00:00+00:00+00:00', '2026-09-17t08:00', '2026-09-17T08:00:00+00:00:00.5',
    '2026-09-17T08:00:00-00:30', '2026-09-17T08:00+0530', '2026-09-17T08:00+05', '2026-09-17T08:00+5',
    '2026-09-17T08:00:00.', '2026-09-17T', '2026-09-17T8:00', '2026-09-17T08:0', '2026-09-17T08:00:00+05:30:15.25',
    '2020-W53-7', '2021-W53-1', '2026-W00-1', '2026-W38-8', '2026-W38-0', '0000-01-01', '9999-12-31T23:59:59.999999',
    '2026-09-17X08:00', '2026-09-17\U0001F60008:00', '2026-09-17é08:00', '2026-09-17T08:00:00Z', '2026-W38-410:00',
    '2026-09-17 08:00:00.000000+00:00', '1970-01-01T00:00:00-12:00', '2026-09-17T08:00:00.123+0800',
]
NUMBERS = [0, 1, 7, 10, 25, 40, 168, 2**53 + 1, 10**20, 0.0, -0.0, 0.5, 1.5, 2.5, 25.5, 12.3456789, 1234565.0,
           1234567.0, 999999.5, 0.0001, 0.00001, 1e-5, 123456.5, 1e16, 3000.5, 2500.5, 2999.999, 1e100, -7.25, 100.05]
ROUND1 = [0.05, 0.15, 0.25, 0.35, 2.675, 99.95, 100.0, 1.0, 51.75, 66.5 * 0.7 + 10, 95 * .7 + 10 + 7.5, 1e16 + 0.5,
          -0.05, 70.0 * .7, 85 * .7 + 2.5 * 3, 0.0]
ROUND0 = [0.5, 1.5, 2.5, 3 / 6 * 100, 5 / 6 * 100, 1 / 6 * 100, 4 / 6 * 100, 2 / 6 * 100, 99.5, 100.0, 0.0, -0.5]

SETTINGS = [
    rules.DEFAULTS,
    rules.DEFAULTS | {'max_weekly_hours': 20},
    rules.DEFAULTS | {'max_weekly_hours': None},
    rules.DEFAULTS | {'max_weekly_hours': 12.5, 'min_fixed_twd': 2500.5},
    rules.DEFAULTS | {'min_fixed_twd': 0, 'categories': ['後端／API']},
    rules.DEFAULTS | {'min_fixed_twd': 10000000, 'categories': ['全端 MVP', 'AI agent']},
]

DEADLINES = ['2099-01-01', '2026-09-16', '2026-09-17T08:00:00Z', '2026-09-17 08:00:00', '2026-09-28', '2026-09-27',
             '2026-09-28T01:00:00Z', '2026-09-28T00:59:59Z', '2026-09-28T09:00:00+08:00', '2026-09-28T09:00:01+08:00',
             '20991231', '2099-W01-1', 'soon', '', None, 20260917, ['2099-01-01'], '2026-09-17T08:00:00ZZ', '2099-01-01T00:00']
TEXTS = [
    ('AI agent workflow', 'Build an agent with tool calling and API integration.'),
    ('Backend API', 'REST API integration'), ('Graphic designer', 'Draw a logo'),
    ('Storage unit manager', 'Manage warehouse inventory'), ('Fullstack MVP', 'Build membership website'),
    ('徵 LLM 聊天機器人', '需要 RAG 與自動化串接'), ('全端網站', '會員系統'), ('aiagent', 'agentic-flow'), ('AI-agent', 'x'),
    ('İSTANBUL LLM', 'ΣΊΣΥΦΟΣ automation'), ('ai 整合', ''), ('', ''), ('API後端', 'mvp'), ('backend_api', 'api2'),
]


def qualify_corpus():
    jobs = [job()]
    jobs += [job(weekly_hours=h) for h in (25, 25.5, 40, 0, -1, None, True, '10', 30, 30.0, 12.5, 168, 1234567.0, 10**7, 2**60)]
    jobs += [job(kind=k) for k in ('hourly', 'contract', 'full_time', None, 'part_time')]
    jobs += [job(currency=c) for c in ('USD', None)]
    jobs += [job(budget_min=a, budget_max=b) for a, b in (
        (None, 8000), (2000, 2999), (9000, 3000), (-1, 5000), (None, None), (4000.0, 8000.5), ('4000', 8000),
        (True, 5000), (2500, 2500.5), (3000, 3000), (2999.5, 10000), (0, 1), (None, 0))]
    jobs += [job(taiwan_eligible=v) for v in (False, None, 'yes')]
    jobs += [job(timezone_compatible=v) for v in (False, None, 1)]
    jobs += [job(deadline=d) for d in DEADLINES]
    jobs += [job(title=t, description=d) for t, d in TEXTS]
    jobs += [job(listing_closed=True), job(compensation_evidence='unpaid_or_equity_only'), job(complete=False),
             job(complete=None), job(kind='hourly', currency='USD', budget_min=30, budget_max=50)]
    jobs += [job(title=None), job(description=7)]
    return jobs


def items_for_ranking():
    published = ['2026-09-27T12:00:00Z', '2026-09-24T00:00:00+00:00', '2026-09-01T00:00:00Z', '2026-09-28T01:00:00Z',
                 '2026-09-28T02:00:00Z', '2026-09-26T01:00:00Z', '2026-09-21T01:00:00Z', '2026-09-27 12:00:00',
                 1790000000, 1790000000.5, 1e20, -1e20, float('nan'), True, None, 'garbage', ['x']]
    items = []
    for n, value in enumerate(published):
        items.append(job(external_id=f'pub-{n}', published_at=value))
    for source in ('himalayas', 'hackernews', 'v2ex', 'tasker'):
        items.append(job(source=source, external_id=f'rx-{source}', received_at='2026-09-27T00:00:00Z'))
    for source in ('jobicy', 'remotive'):
        items.append(job(source=source, external_id=f'pe-{source}', publication_evidence='2026-09-27 00:00:00'))
        items.append(job(source=source, external_id=f'pe2-{source}', publication_evidence='2026-09-27T00:00:00+08:00'))
        items.append(job(source=source, external_id=f'pe3-{source}', published_at='2026-09-27 00:00:00',
                         publication_evidence='2026-09-27'))
    items += [job(external_id='w', weekly_hours=31), job(external_id='nofix', kind='hourly'),
              job(external_id='cheap', budget_min=2000, budget_max=2500), job(external_id='nodl', deadline=None),
              job(external_id='tz', timezone_compatible=None, taiwan_eligible=None), job(external_id='x', title='Draw a logo', description='')]
    return items


def ranking_corpus():
    out = []
    for settings in (SETTINGS[0], SETTINGS[2], SETTINGS[1]):
        for j in items_for_ranking():
            for feedback in ('neutral', 'interested'):
                item = dict(id=identity_hash([j['source'], j['external_id']]), job=j, fingerprint='f' * 64,
                            evaluation=rules.evaluate(j, settings, NOW), review_status='draft',
                            tracking=dict(feedback=feedback))
                out.append(dict(input=tag(item), expect=attempt(lambda: encode(ranking.recommendation(item, NOW)))))
    return out


# ---------------------------------------------------------------- store scenarios
def ref_id(ref):
    return ref if isinstance(ref, str) else identity_hash(list(ref))


def run_scenario(ops):
    with tempfile.TemporaryDirectory() as tmp:
        clock = [NOW]
        store = SQLiteStore(Path(tmp) / 'golden.db', clock=lambda: clock[0])
        store.migrate()
        captured = {}
        results = []

        def versions(key):
            group = next((g for g in rules.group_items(store.list()) if key in g['member_ids']), None)
            return {} if group is None else {m['id']: m['token'] for m in group['members']}

        for op in ops:
            kind = op['op']
            if kind == 'ingest':
                fn = lambda: encode(store.ingest(op['job'], op.get('receipt_id')))
            elif kind == 'batch':
                def fn():
                    with store.source_batch(op['source']) as batch:
                        for j, receipt in op['items']:
                            batch.ingest(j, receipt_id=receipt)
                        if op.get('finish'):
                            batch.finish(op['finish'])
                        return encode(sorted(batch.existing_ids()))
            elif kind == 'set_preferences':
                fn = lambda: encode(store.set_preferences(op['revision'], op['settings']))
            elif kind == 'track':
                fn = lambda: encode(store.track(ref_id(op['ref']), op['revision'], **op.get('kw', {})))
            elif kind == 'capture':
                def fn():
                    captured[ref_id(op['ref'])] = versions(ref_id(op['ref']))
                    return encode(captured[ref_id(op['ref'])])
            elif kind == 'feedback':
                def fn():
                    key = ref_id(op['ref'])
                    chosen = captured[key] if op['versions'] == 'captured' else versions(key)
                    return encode(store.feedback(key, chosen, op['feedback']))
            elif kind == 'health':
                fn = lambda: encode(store.set_source_health(op['source'], op['status']))
            elif kind == 'clock':
                def fn():
                    clock[0] = datetime.fromisoformat(op['now'])
                    return encode(None)
            elif kind == 'list':
                fn = lambda: encode(store.list())
            elif kind == 'groups':
                fn = lambda: encode(rules.group_items(store.list()))
            elif kind == 'public':
                fn = lambda: encode([rules.public_item(g) for g in rules.group_items(store.list())])
            elif kind == 'preferences':
                fn = lambda: encode(store.preferences())
            elif kind == 'sources':
                fn = lambda: encode(store.sources())
            elif kind == 'existing':
                fn = lambda: encode(sorted(store.existing_source_ids(op['source'])))
            else:
                raise ValueError(kind)
            results.append(attempt(fn))
        with store._connect(write=False) as conn:
            tables = {}
            # Wall-clock defaults (received_at, checked_at) are volatile on both sides and left out.
            for table, columns, order in (
                    ('opportunities', 'id,source,external_id,item', 'id'),
                    ('proposal_revisions', 'opportunity_id,version,proposal,fingerprint', 'opportunity_id,version'),
                    ('source_receipts', 'source,receipt_id,opportunity_id', 'source,receipt_id'),
                    ('source_health', 'source,status', 'source'),
                    ('opportunity_tracking', 'opportunity_id,state', 'opportunity_id'),
                    ('tracking_events', 'id,opportunity_id,revision,state,created_at', 'id'),
                    ('discovery_settings', 'id,revision,settings', 'id')):
                tables[table] = [list(row.values()) for row in conn.execute(f'SELECT {columns} FROM {table} ORDER BY {order}')]
    return results, tables


def tag_op(op):
    return {k: tag(v) if k in ('job', 'settings', 'kw', 'revision') else
            [[tag(j), r] for j, r in v] if k == 'items' else v for k, v in op.items()}


BODY = 'Build an agent integration with API, database, tests and deployment. ' * 3
SCENARIOS = {
    'requalify_on_preferences': [
        dict(op='ingest', job=job(weekly_hours=25)), dict(op='list'),
        dict(op='set_preferences', revision=0, settings=rules.DEFAULTS | {'max_weekly_hours': 20}), dict(op='list'),
        dict(op='set_preferences', revision=1, settings=rules.DEFAULTS | {'max_weekly_hours': None}), dict(op='list'),
        dict(op='set_preferences', revision=1, settings=rules.DEFAULTS), dict(op='preferences'),
    ],
    'preferences_validation_and_unknown_eligibility': [
        *[dict(op='set_preferences', revision=0, settings=rules.DEFAULTS | change) for change in (
            {'max_weekly_hours': True}, {'min_fixed_twd': -1}, {'categories': [[]]}, {'categories': []},
            {'categories': ['unknown']}, {'categories': ['AI agent', 'AI agent']}, {'max_weekly_hours': 0},
            {'max_weekly_hours': 168.0}, {'min_fixed_twd': 10000000.5})],
        dict(op='set_preferences', revision=0, settings={'max_weekly_hours': 30}),
        dict(op='set_preferences', revision=True, settings=rules.DEFAULTS),
        dict(op='set_preferences', revision=0.0, settings=rules.DEFAULTS),
        dict(op='ingest', job=job(taiwan_eligible=None, weekly_hours=None)), dict(op='list'),
        dict(op='set_preferences', revision=0, settings=rules.DEFAULTS | {'categories': ['後端／API']}), dict(op='list'),
    ],
    'track_and_recommendation': [
        dict(op='preferences'), dict(op='ingest', job=job()),
        dict(op='track', ref=['freelancer', '101'], revision=0, kw=dict(feedback='interested', note=' Keep ')),
        dict(op='track', ref=['freelancer', '101'], revision=0, kw=dict(feedback='skipped')),
        dict(op='track', ref=['freelancer', '101'], revision=1, kw=dict(feedback='skipped', reason='other')),
        dict(op='track', ref=['freelancer', '101'], revision=1, kw=dict(feedback='skipped', reason='budget', note='low')),
        dict(op='track', ref=['freelancer', '101'], revision=2, kw=dict(stage='applied')),
        dict(op='track', ref=['freelancer', '101'], revision=2, kw=dict(stage='applied', evidence=' ref-1 ')),
        dict(op='track', ref=['freelancer', '101'], revision=3, kw=dict(stage='won')),
        dict(op='track', ref=['freelancer', '101'], revision=4, kw=dict(stage='not_applied')),
        dict(op='track', ref=['freelancer', '101'], revision=4, kw=dict(stage='not_applied', note='mistake')),
        dict(op='track', ref=['freelancer', '101'], revision=5, kw=dict(stage='replied')),
        dict(op='track', ref=['freelancer', '101'], revision=5, kw=dict(feedback='neutral', note='x' * 2001)),
        dict(op='track', ref=['freelancer', '101'], revision=5, kw={}),
        dict(op='track', ref=['freelancer', 'missing'], revision=0, kw=dict(feedback='interested')),
        dict(op='clock', now='2026-09-29T03:04:05.123456+00:00'),
        dict(op='track', ref=['freelancer', '101'], revision=5, kw=dict(feedback='neutral', stage='applied', evidence='e2')),
        dict(op='list'), dict(op='groups'), dict(op='public'),
    ],
    'url_and_content_grouping': [
        dict(op='ingest', job=job()),
        dict(op='ingest', job=job(source='tasker', external_id='cross', url='https://www.freelancer.com/projects/example-101#details')),
        dict(op='groups'),
        dict(op='ingest', job=job(external_id='c1', company='Example', description=BODY)),
        dict(op='ingest', job=job(source='tasker', external_id='copy', company='Example', description=BODY)),
        dict(op='ingest', job=job(source='tasker', external_id='different', company='Another', description=BODY)),
        dict(op='ingest', job=job(source='tasker', external_id='conflict', company='Example', description=BODY, taiwan_eligible=False)),
        dict(op='ingest', job=job(source='tasker', external_id='card', company='Example', description=BODY, body_available=False)),
        dict(op='ingest', job=job(source='guru', external_id='http', url='http://www.freelancer.com/projects/example-101')),
        dict(op='ingest', job=job(source='guru', external_id='userinfo', url='https://u:p@www.freelancer.com/projects/example-101')),
        dict(op='ingest', job=job(source='guru', external_id='canonical', url='https://elsewhere.example/x',
                                  canonical_url='https://www.freelancer.com/projects/example-101')),
        dict(op='ingest', job=job(source='guru', external_id='weird', url='https://[::1/x')),
        dict(op='ingest', job=job(source='guru', external_id='nonstr', url=7, company='Ｅｘａｍｐｌｅ', description=BODY.upper())),
        dict(op='groups'), dict(op='public'),
    ],
    'group_feedback_atomic_and_stale': [
        dict(op='ingest', job=job()), dict(op='capture', ref=['freelancer', '101']),
        dict(op='ingest', job=job(source='tasker', external_id='cross', url='https://www.freelancer.com/projects/example-101')),
        dict(op='feedback', ref=['freelancer', '101'], versions='captured', feedback='skipped'),
        dict(op='capture', ref=['freelancer', '101']),
        dict(op='feedback', ref=['freelancer', '101'], versions='captured', feedback='interested'),
        dict(op='feedback', ref=['freelancer', '101'], versions='captured', feedback='neutral'),
        dict(op='capture', ref=['freelancer', '101']),
        dict(op='ingest', job=job(description='Updated API scope')),
        dict(op='feedback', ref=['freelancer', '101'], versions='captured', feedback='skipped'),
        dict(op='feedback', ref=['freelancer', '101'], versions='current', feedback='bogus'),
        dict(op='feedback', ref=['freelancer', 'nope'], versions='current', feedback='skipped'),
        dict(op='feedback', ref=['freelancer', '101'], versions='current', feedback='skipped'),
        dict(op='list'), dict(op='groups'),
        dict(op='feedback', ref=['freelancer', '101'], versions='current', feedback='neutral'),
        dict(op='groups'),
    ],
    'dedup_refresh_and_receipts': [
        dict(op='ingest', job=job(), receipt_id='r1'),
        dict(op='ingest', job=job(), receipt_id='r1'),
        dict(op='ingest', job=job(received_at='2026-09-27T00:00:00Z'), receipt_id='r2'),
        dict(op='ingest', job=job(external_id='102'), receipt_id='r1'),
        dict(op='ingest', job=job(description='Changed scope API agent'), receipt_id='r3'),
        dict(op='ingest', job=job(description='Changed scope API agent', evidence_ref='mail:x'), receipt_id='r4'),
        dict(op='ingest', job=job(), receipt_id=''),
        dict(op='ingest', job=job(external_id='')),
        dict(op='ingest', job=job(source=None)),
        dict(op='ingest', job=job(external_id=101)),
        dict(op='ingest', job=job(source='tasker', external_id='n1', receipt_id='m:1', received_at='2026-09-27T10:00:00+00:00')),
        dict(op='ingest', job=job(source='tasker', external_id='n1', receipt_id='m:0', received_at='2026-09-26T10:00:00+00:00',
                                  description='Older notification agent API')),
        dict(op='ingest', job=job(source='tasker', external_id='n1', receipt_id='m:2', received_at='2026-09-28T10:00:00Z',
                                  description='Newer notification agent API')),
        dict(op='ingest', job=job(source='tasker', external_id='n1', receipt_id='m:3', received_at='2026-09-29 10:00:00',
                                  description='Naive time agent API')),
        dict(op='ingest', job=job(title=None, external_id='bad')),
        dict(op='set_preferences', revision=0, settings=rules.DEFAULTS | {'max_weekly_hours': 5}),
        dict(op='ingest', job=job()),
        dict(op='list'),
    ],
    'skip_survives_new_observation_and_legacy_fields': [
        dict(op='ingest', job=job()),
        dict(op='track', ref=['freelancer', '101'], revision=0, kw=dict(feedback='skipped', reason='scope')),
        dict(op='ingest', job=job(description='Scope changed for agent API')),
        dict(op='track', ref=['freelancer', '101'], revision=1, kw=dict(feedback='interested')),
        dict(op='ingest', job=job(description='Scope changed again for agent API')),
        dict(op='list'),
    ],
    'source_batch': [
        dict(op='batch', source='tasker', items=[[job(source='tasker', external_id='one'), 'receipt-one']], finish='ok'),
        dict(op='batch', source='tasker', items=[[job(source='tasker', external_id='one'), 'receipt-one']], finish='ok'),
        dict(op='existing', source='tasker'), dict(op='sources'),
        dict(op='health', source='guru', status='failed'),
        dict(op='batch', source='guru', items=[[job(source='guru', external_id='one'), 'same'], [job(source='guru', external_id='two'), 'same']], finish='ok'),
        dict(op='batch', source='tasker', items=[[job(source='freelancer'), 'wrong']]),
        dict(op='batch', source='nope', items=[]),
        dict(op='health', source='tasker', status='bogus'), dict(op='health', source='nope', status='ok'),
        dict(op='existing', source='nope'), dict(op='sources'), dict(op='list'),
    ],
}


HTML = [
    '<p>Build an API</p>', 'plain', 'a &amp; b', '&ampx', '&amp', 'x &notin; y', '&notit;', '&notanentity;', '&Aacute', '&AMP;',
    '&#65;&#x42;&#0;&#128;&#xD800;&#1114112;&#xFFFE;&#x1F600;', '&#', '&#;', '&#x;', 'tail &amp', 'tail &am', 'tail & x', 'tail &',
    'a' * 40 + '&amp', '&amp' + 'b' * 40, 'a' * 40 + '&amp;', '\U0001f600' * 40 + '&amp', 'x' * 20 + '\U0001f600' * 15 + '&am',
    'a<b', 'a < b', '<', 'x<', '<p', '<p class="a"', 'x <p class="a" y',
    '<div>a</div><li>b</li><br>c<br/>d', '<script>x<p>y</script>z', '<SCRIPT>x</script >y', '<script>never closed', '<script>a</scriptx>b',
    '<style>a{}</style>b', '<script/>visible', '<script><script></script>v', '<style><style></style>x', '</script>after',
    '<!-- c -->t', '<!-->t', '<!--->t', '<!-->a-->b', '<!--->x<!-- y -->z', '<!-- x --!>t', '<!-- unterminated', '<!DOCTYPE html>t', '<!doctype>t', '<![CDATA[x]]>t',
    '<![CDATA[x', '<?pi>t', '<?pi', '<!bogus>t', '<!bogus', '</>t', '</ x>t', '</1>t', '</p', '</p x="y>',
    '<title>a &amp; b</title>', '<textarea><p>x &lt;</textarea>y', '<xmp><b>&amp;</b></xmp>', '<iframe>x</iframe>y',
    '<noembed>x</noembed>', '<noscript><p>x</p></noscript>', '<plaintext><p>&amp;', '<a href="x>y">link</a>', "<a b='c'd>t",
    '<a b="c"d>t', '<p/ >x', '<br/>x', '<img src=x />x', 'x\u00a0y\u3000z\x1c\x85w', '<P>Upper</P>', '<scr\u0130pt>x</scr\u0130pt>y',
    '<div\n class=x>y</div\n>', '<a <b>c', '<<p>>', '<p>\U0001f600 &hearts; &#9829;</p>', '<li>one<li>two', '<a\tb>t',
    '<p =x>t', '<p a=>t', '<p a= >t', "<p a='>'>t", '<p a="b"/>t', '<p/>t', '&lt;script&gt;x',
    '<p>' + '&#' + '1' * 5000 + ';</p>', '<a href="&#' + '1' * 4301 + '">x</a>', '<a href="&#' + '1' * 4300 + '">x</a>',
    '<a b=&#' + '1' * 4301 + ' !>x', '<a href="&amp=x&amp;y">t</a>', '<p>&#x' + 'f' * 50 + ';</p>', 'R&D &copy 2026', '&nbsp;&nbsp', '&#x20AC;&#8364&euro;',
]


def html_text(html):
    t = free_jobs.Text()
    t.feed(html)
    return ''.join(t.parts)


def rem(**changes):
    """backend/tests/collection/test_free_jobs.py:rem"""
    return dict(id=1, url='https://remotive.com/remote-jobs/software-dev/backend-1', title='Backend API engineer',
                description='<p>Build an API</p>', job_type='part_time', publication_date='2026-09-18T12:00:00',
                candidate_required_location='Worldwide') | changes


def jobicy(**changes):
    return dict(id=2, url='https://jobicy.com/jobs/2-python', jobTitle='Python API', jobDescription='<p>API</p>',
                jobType=['contract'], jobGeo='Anywhere', pubDate='2026-09-18T12:00:00+00:00', salaryMin=100000,
                salaryPeriod='yearly') | changes


def without(d, key):
    return {k: v for k, v in d.items() if k != key}


NORMALIZE = [
    ('remotive', rem()), ('jobicy', jobicy()), ('nope', rem()), ('remotive', []), ('remotive', None), ('jobicy', 'x'),
    *[('remotive', rem(job_type=t)) for t in ('full_time', 'Full-Time', 'Part-Time', 'Freelance', 'contract', '', None,
                                              'internship', 'Part Time', '\u03a3\u0391\u03a3', 'CONTRACT',
                                              '\u1c89\ua7cb\ua7dc')],  # unassigned in Unicode 15.1, cased in Node's ICU
    ('remotive', without(rem(), 'job_type')),
    *[('remotive', rem(candidate_required_location=g)) for g in ('USA', ' usa ', 'Worldwide', None, 0, '', [], 5, 'Europe',
                                                                 'United Kingdom', 'Taiwan', 'Canada\u3000', False, True)],
    ('remotive', without(rem(), 'candidate_required_location')),
    *[('remotive', rem(url=u)) for u in ('https://evil.example/', None, 'https://remotive.com/remote-jobs/x?utm=1#frag',
                                         'https://www.remotive.com/remote-jobs/x', 'http://remotive.com/remote-jobs/x',
                                         'https://remotive.com/jobs/x', 5, [], {}, 0, True, 'HTTPS://remotive.com/remote-jobs/x',
                                         'https://remotive.com:443/remote-jobs/x', ' https://remotive.com/remote-jobs/x\t',
                                         'https://remotive.com/remote-jobs/a?', 'https://remotive.com/remote-jobs/a#',
                                         'https://[V1.a]/remote-jobs/x', 'https://remotive.com/remote-jobs/\u5f8c\u7aef')],
    ('remotive', without(rem(), 'url')),
    *[('remotive', rem(id=i)) for i in (0, -1, '1', 1.0, True, 2 ** 70, None)],
    ('remotive', without(rem(), 'id')),
    *[('remotive', rem(title=t)) for t in ('', 'x' * 501, 'x' * 500, None, '\u5f8c\u7aef API \U0001f600', '\U0001f600' * 500)],
    *[('remotive', rem(description=d)) for d in (None, '<script>x</script>', '<p>&amp;</p>', '   ', '<p>\u5f8c\u7aef &eacute;</p>',
                                                 'x' * 100001, '<p>a</p>' + 'b' * 99993, 'line1<br>line2\n\tline3')],
    *[('remotive', rem(publication_date=d)) for d in ('2026-09-18T12:00:00Z', '2026-09-18', 'bad', None, '2026-09-18T12:00:00+05:30',
                                                      'ZZ', '2026-09-18T12:00:00.5Z', '2026-09-18 12:00:00-0800', 20260918)],
    *[('jobicy', jobicy(jobType=t)) for t in (['Full-Time', 'Contract'], 'contract', [1], [], None, ['part-time', 'Part_Time'])],
    ('jobicy', without(jobicy(), 'jobType')),
    ('jobicy', jobicy(url='https://jobicy.com/remote-jobs/2')), ('jobicy', jobicy(jobGeo='USA')), ('jobicy', jobicy(pubDate='2026-09-18 12:00:00')),
    ('jobicy', jobicy(title='ignored', jobTitle=None)), ('jobicy', jobicy(description='ignored', jobDescription='')),
]


def normalize_case(source, payload):
    def run():
        j = free_jobs.normalize(source, payload)
        aware = datetime.fromisoformat(payload['publication_date' if source == 'remotive' else 'pubDate'].replace('Z', '+00:00')).tzinfo
        return dict(job=encode(without(j, 'received_at')), received_at=j['received_at'] if aware else None)
    return dict(source=source, payload=tag(payload), expect=attempt(run))


# ---------------------------------------------------------------- plan step 7: CryptoJobsList
TEXT = HTML + [
    '<p>a</p><p>b</p>', '<h1>T</h1>x<h3>y</h3><tr>z', 'a\r\nb\rc\x0bd\x0ce\x1cf\x1dg\x1eh\x85i j k', '  \n\t ',
    '<p>  spaced   out  </p>\n\n\n<p>x</p>', '<script>a', '<style>a', '<title>a &amp', '<p', '</', 'x</', '<!--', '<!', '<?', 'a<b',
    '<textarea>a &lt; b', 'x &amp', 'x &#38', '&#x', '<![CDATA[', '<!doctype', '<a href="x', 'a</p', 'y' * 200001, ' ', '',
    None, 5, '<p>\U0001f600</p>',
]

PARSEDATE = [
    'Sat, 24 Oct 2026 07:50:03 GMT', 'Sat, 24 Oct 2026 07:50:03 +0000', 'Sat, 24 Oct 2026 07:50:03 -0000', '24 Oct 2026 07:50:03 +0530',
    'Sat,24 Oct 2026 07:50:03 GMT', 'Sat, 24 Oct 26 07:50:03 EST', 'Sat, 24 Oct 69 07:50 PDT', 'Sat, 24 Oct 68 07:50:03 Z',
    'Saturday, 24-Oct-26 07:50:03 GMT', '24 October 2026 07:50:03 GMT', 'Oct 24 2026 07:50:03 GMT', '24 Oct 2026 07.50.03 GMT',
    '24 Oct 2026 07.50 GMT', '24 Oct 2026 07 GMT', '24 Oct 2026 07:50:03:01 GMT', '24 Oct 2026 07:50:03+0100', '24 Oct 2026 07:50:03-0100',
    '24 Oct 2026, 07:50:03 GMT', '24 Oct, 2026 07:50:03 GMT', '24, Oct 2026 07:50:03 GMT', '24 Oct 2026 07:50:03, GMT', '24 Oct , 07:50 GMT',
    '24 Oct 2026 07:50:03 XYZ', '24 Oct 2026 07:50:03 +9999', '24 Oct 2026 07:50:03 +2400', '24 Oct 2026 07:50:03 +2359', '24 Oct 2026 07:50:03 -2359',
    '24 Oct 2026 07:50:03 +0000000000000000000099', '24 Oct 2026 07:50:03 1_00', '24 Oct 2026 07:50:03 gmt', '24 Oct 2026 07:50:03 ıst',
    '24 Oct 2026 07:50:03 EſT', '24 Oct 2026 07:50:03 ﬅ', '24 Oct 2026 07:50:03 ＋0100', '24 Oct 2026 07:50:03 ٠١٠٠',
    '٢٤ Oct ٢٠٢٦ ٠٧:50:03 GMT', '24 Oct ²026 07:50:03 GMT', '24 Oct 2026 07:5_0:03 GMT',
    '24 OCT 2026 07:50:03 GMT', '24 oct 2026 07:50:03 GMT', '24 Oc 2026 07:50:03 GMT', '32 Oct 2026 07:50:03 GMT', '29 Feb 2025 07:50:03 GMT',
    '24 Oct 10000 07:50:03 GMT', '24 Oct 0 07:50:03 GMT', '24 Oct 99999999999999999999 07:50:03 GMT', '24 Oct 2026 24:00:00 GMT',
    '24 Oct 2026 07:60:00 GMT', '24 Oct 2026 07:50:60 GMT', '24 Oct 2026 -1:50:00 GMT', '', '   ', 'garbage', 'Mon,', 'Mon, 24',
    '1 Jan 0001 00:00:00 +0100', '31 Dec 9999 23:59:59 -0100', '2026-10-24T07:50:03.+00:00', '2026-10-24T07:50:03.Z',
    '2026-10-24T07:50:03,Z', '2026-10-24T07:50.+00:00', '2026-10-24T07.+00:00', '0001-01-01\u300007:50:03.+08', '2026-10-24T07:50:03.', 'Sat, 24 Oct 2026 07:50:03 GMT extra words', '24　Oct　2026　07:50:03　GMT',
    'Mon 24 Oct 2026 07:50:03', 'mon, 24 Oct 2026 07:50:03 GMT', 'Fri, 24 Oct 2026 07:50:03 +0000', '2026-10-24T07:50:03Z',
]

INTS = ['0', '-1', '+1', ' 12 ', '1_000', '_1', '1_', '1__0', '١٢', '²', '１', '1.0', '', ' ', '　 7 　', '0x10', '00012',
        '+-1', '๑๒', '\U0001d7ce', '1' * 4300, '1' * 4301, '--1', '+', '١_٢', '\x1c5\x1f']

MRSS = 'http://search.yahoo.com/mrss/'


def item(link='https://cryptojobslist.com/jobs/backend-engineer-acme', title='Backend Engineer',
         desc='<p>Tags: <a href="https://cryptojobslist.com/part-time">Part-time</a> <a href="https://cryptojobslist.com/remote">Remote</a></p><p>Build things.</p>',
         canonical=None, location='Remote', pub='Sat, 24 Oct 2026 07:50:03 GMT', cdata=True, extra=''):
    parts = []
    if link is not None:
        parts.append(f'<link>{link}</link>')
    if title is not None:
        parts.append(f'<title><![CDATA[{title}]]></title>' if cdata else f'<title>{title}</title>')
    if desc is not None:
        parts.append(f'<description><![CDATA[{desc}]]></description>' if cdata else f'<description>{desc}</description>')
    if canonical is not None:
        parts.append(f'<media:canonical>{canonical}</media:canonical>')
    if location is not None:
        parts.append(f'<media:location>{location}</media:location>')
    if pub is not None:
        parts.append(f'<pubDate>{pub}</pubDate>')
    return '<item>' + ''.join(parts) + extra + '</item>'


def rss(*items, head='<?xml version="1.0" encoding="UTF-8"?>', built='Sat, 24 Oct 2026 07:50:03 GMT'):
    b = f'<lastBuildDate>{built}</lastBuildDate>' if built is not None else ''
    return f'{head}<rss xmlns:media="{MRSS}" version="2.0"><channel><title>CJL</title>{b}{"".join(items)}</channel></rss>'


TAGS = '<p>Tags: <a href="https://cryptojobslist.com/{}">x</a></p>'
RSS = [
    rss(item()), rss(item(), item()), rss(item(), item(link='https://cryptojobslist.com/jobs/other-1')),
    rss(item(desc=TAGS.format('full-time') + TAGS.format('part-time'))), rss(item(desc='<p>Tags: <a href="https://cryptojobslist.com/full-time">a</a> <a href="https://cryptojobslist.com/freelance">b</a></p>')),
    rss(item(desc='<p>Tags: <a href="https://cryptojobslist.com/contract">smart contract</a></p><p>x</p>')),
    rss(item(desc='<p>No label <a href="https://cryptojobslist.com/part-time">a</a></p>')),
    rss(item(desc='<p>Tags: <a href="https://cryptojobslist.com/part-time">a</a></p><p><a href="https://cryptojobslist.com/remote">late</a></p>')),
    rss(item(desc='<h2>x</h2><p>Tags: <a href="https://cryptojobslist.com/part-time">a</a></p>')),
    rss(item(desc='<p>Tags:<h3>h</h3><a href="https://cryptojobslist.com/part-time">a</a></p>')),
    rss(item(desc='<p>Tags: <a href="http://cryptojobslist.com/part-time">a</a><a href="https://www.cryptojobslist.com/remote">b</a><a>c</a><a href>d</a><a href="https://cryptojobslist.com//x/y//">e</a></p>')),
    rss(item(desc='<p>Tags: <a href="https://[bad/part-time">a</a></p>')), rss(item(desc='<p>Tags: <a HREF="https://cryptojobslist.com/part-time" href="https://cryptojobslist.com/remote">a</a></p>')),
    rss(item(desc='<p>Tags: <a href="https://cryptojobslist.com/part&#45;time">a</a></p>')), rss(item(desc='  <p>  Tags: <a href="https://cryptojobslist.com/freelance">a</a>')),
    rss(item(desc='<div><p>Tags: <a href="https://cryptojobslist.com/freelance">a</a></p></div>')), rss(item(desc='<p>Tags: <a href="https://cryptojobslist.com/freelance">a</a>')),
    rss(item(desc='<script>x</script>')), rss(item(desc='')), rss(item(desc=None)), rss(item(desc='x' * 100001)), rss(item(desc='<p>a</p>' + 'b' * 99999)),
    rss(item(title='')), rss(item(title=None)), rss(item(title='t' * 501)), rss(item(title='<b>Bold</b> &amp; title', cdata=False)),
    rss(item(title='A &amp;amp; B', cdata=False)), rss(item(title='後端 \U0001f600')),
    *[rss(item(link=l)) for l in (None, '', 'https://cryptojobslist.com/jobs/x', 'https://cryptojobslist.com/jobs/ab', 'https://cryptojobslist.com/jobs/AB-c',
                                  'https://cryptojobslist.com/jobs/a_b', 'https://cryptojobslist.com/jobs/ab?ref=1#f', 'https://cryptojobslist.com/jobs/ab/',
                                  'http://cryptojobslist.com/jobs/ab', 'https://cryptojobslist.com:443/jobs/ab', ' https://cryptojobslist.com/jobs/ab ',
                                  'https://cryptojobslist.com/jobs/-ab', 'https://cryptojobslist.com/jobs/éb', 'HTTPS://cryptojobslist.com/jobs/ab',
                                  'https://cryptojobslist.com/jobs/ab\n', 'https://cryptojobslist.com/jobs/a\tb')],
    *[rss(item(canonical=c)) for c in ('', 'https://cryptojobslist.com/jobs/backend-engineer-acme', 'https://cryptojobslist.com/jobs/backend-engineer-acme?x=1',
                                       'https://cryptojobslist.com/jobs/other', 'https://evil.example/jobs/x')],
    *[rss(item(location=l)) for l in (None, '', '   ', 'US only', 'us ONLY', 'USA only, remote', 'United States', 'Europe only', 'UK only', 'Remote (US only)',
                                      'US onlyx', 'xUS only', 'Uſ only', 'Unİted States', 'Unıted States', 'éUS only', 'US onlyé', 'remote',
                                      'REMOTE', 'Remote-first', 'remoteness', 'ſremote', 'Remoté', 'Taipei', '_remote', 'remote_')],
    *[rss(item(pub=d)) for d in (None, '', '2026-10-24T07:50:03Z', '2026-10-24T07:50:03', '2026-10-24', 'Sat, 24 Oct 2026 07:50:03 -0000', 'nonsense',
                                 'Sat, 24 Oct 2026 07:50:03 +0530', '1 Jan 0001 00:30:00 +0100', '31 Dec 9999 23:59:59 -0100', '2026-10-24T07:50:03.5+00:00')],
    rss(item(), built=None), rss(item(), built=''),
    rss(item(location='Remote', desc='<p>Tags: <a href="https://cryptojobslist.com/part-time">a</a></p><p>x &amp; y &lt;b&gt;</p>', cdata=False)),
    rss(item(extra='<unknown>z</unknown>')), rss(item(extra='<media:location>second</media:location>')),
    rss(item(link='https://cryptojobslist.com/jobs/ab', extra='<link>https://cryptojobslist.com/jobs/cd</link>')),
    rss(), rss(*[item(link=f'https://cryptojobslist.com/jobs/j{n}') for n in range(3)]),
    '<rss><channel/></rss>', '<feed><channel><item/></channel></feed>', '<rss/>', '<rss><item/></rss>', '<rss><channel><item/></channel></rss>',
    '<!DOCTYPE rss><rss/>', '<!  entity x>', '<!doctypex', '<rss><channel>' + item() + '</channel>', '<rss><channel>' + item() + '</channel></rss>trailing',
    '<rss><channel>' + item() + '</channel></rss><!-- c -->', '<rss xmlns:media="x"><channel>' + item() + '</channel></rss>',
    '<rss><channel>' + item() + '</channel></rss>', '<rss><channel>' + item().replace('&', '&') + '&nbsp;</channel></rss>',
    '﻿' + rss(item()), '<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel>' + item(title='café') + '</channel></rss>',
    '<?xml version="1.0" encoding="us-ascii"?><rss><channel>' + item() + '</channel></rss>', rss(item(title='a\r\nb\rc')),
    '<rss version="2.0"><channel><item><link>https://cryptojobslist.com/jobs/ab</link><title>t</title><description>&lt;p&gt;d&lt;/p&gt;</description></item></channel></rss>',
    '<a:rss xmlns:a="u"><channel/></a:rss>', '<rss xmlns="http://default/"><channel>' + item() + '</channel></rss>',
    '<rss><channel>' + item(title='x&#0;y', cdata=False) + '</channel></rss>', '<rss><channel>' + item(title='x&#x1F600;y', cdata=False) + '</channel></rss>',
    '<rss><channel>' + item(title='x\x01y') + '</channel></rss>',
    '<?xml version="1.1"?><rss><channel>' + item(link='https://cryptojobslist.com/jobs/ab\x85') + '</channel></rss>',
    '<?xml version="1.1"?><rss><channel>' + item(title='a&#1;b', cdata=False) + '</channel></rss>',
]
# Raw byte documents the str corpus cannot express, as latin-1 strings.
RSS_BYTES = [
    rss(item(title='café')).encode('utf-8')[:-30].decode('latin-1'), 'abc', '',
    '<?xml version="1.0" encoding="UTF-8"?><rss><channel>' + item(title='caf\xe9') + '</channel></rss>',
    '\xff\xfe' + rss(item()).encode('utf-16-le').decode('latin-1'),
]


def cjl_case(doc, raw):
    def run():
        r = cryptojobslist.parse(raw, now=NOW)
        return dict(result=encode({k: v for k, v in r.items() if k != 'jobs'}), jobs=[encode(j) for j in r['jobs']])
    return dict(input=doc, expect=attempt(run))


def main():
    golden = {
        'python': sys.version,
        'now': NOW.isoformat(),
        'fromisoformat': [dict(input=s, expect=attempt(lambda: (lambda d: [d.year, d.month, d.day, d.hour, d.minute, d.second,
            d.microsecond, None if d.utcoffset() is None else d.utcoffset() // timedelta(microseconds=1)])(datetime.fromisoformat(s))))
            for s in ISO],
        'format_g': [dict(input=tag(x), expect=format(x, 'g')) for x in NUMBERS],
        'format_thousands': [dict(input=tag(x), expect=format(x, ',.0f')) for x in NUMBERS],
        'round1': [dict(input=tag(x), expect=tag(round(x, 1))) for x in ROUND1 + NUMBERS],
        'round0': [dict(input=tag(x), expect=tag(round(x))) for x in ROUND0 + [n for n in NUMBERS if isinstance(n, float) and n < 1e300]],
        'evaluate': [dict(job=tag(j), settings=tag(s), expect=attempt(lambda: encode(rules.evaluate(j, s, NOW))))
                     for s in SETTINGS for j in qualify_corpus()],
        'recommendation': ranking_corpus(),
        'scenarios': {},
        'html_text': [dict(input=h, expect=attempt(lambda: html_text(h))) for h in HTML],
        'free_jobs_normalize': [normalize_case(src, pl) for src, pl in NORMALIZE],
        'public_text': [dict(input=tag(h), expect=attempt(lambda: public_feeds.text(h))) for h in TEXT],
        'parsedate': [dict(input=s, expect=attempt(lambda: parsedate_to_datetime(s).isoformat())) for s in PARSEDATE],
        'published': [dict(input=s, expect=attempt(lambda: public_feeds.published(s).isoformat())) for s in PARSEDATE],
        'py_int': [dict(input=s, expect=attempt(lambda: str(int(s)))) for s in INTS],
        'cryptojobslist_parse': [cjl_case(d, d.encode('utf-8')) for d in RSS] + [dict(cjl_case(d, d.encode('latin-1')), latin1=True) for d in RSS_BYTES],
    }
    for name, ops in SCENARIOS.items():
        results, tables = run_scenario(ops)
        golden['scenarios'][name] = dict(ops=[tag_op(op) for op in ops], results=results, tables=tables)
    (HERE / 'golden.json').write_text(json.dumps(golden, ensure_ascii=False, indent=0) + '\n')
    counts = {k: len(v) for k, v in golden.items() if isinstance(v, (list, dict))}
    print(counts)


if __name__ == '__main__':
    main()

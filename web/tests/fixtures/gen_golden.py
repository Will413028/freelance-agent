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
from freelance.modules.collection import community_jobs, getonboard, himalayas  # noqa: E402
from email.utils import parsedate_to_datetime                          # noqa: E402
from unittest.mock import patch                                        # noqa: E402
import re                                                              # noqa: E402

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


# ---------------------------------------------------------------- plan step 8, batch 1
FLOATS = ['8', ' 8 ', '8.0', '+8', '-5.5', '1_0', '1__0', '_1', '1_', '1e1_0', '1_e1', '1._5', '.5', '5.', '.', '', ' ', 'inf',
          '-Infinity', 'nan', 'NaN', '+nan', '-nan', 'infinit', 'iNf', 'infinityy', '0x10', '1e400', '-1e400', '1e', 'e5', '١٢',
          '８', '　 7 　', '\x1c5', '5\x85', '1.5e-3', '00012', '1,5', '٫5', '²', '1_000.000_1', '0_0', '+-1', '1e+5',
          '1E-5', '9' * 400, '9' * 400 + '.5', '1e-400', '4.9e-324', '2.5e-324', '0.1', '1.7976931348623157e308',
          '1.7976931348623159e308', '+.5e1', '- 1', '1 2', '١.٢', '1 ']

FROMTS = [0, -1, 253402300799, 253402300800, -62135596800, -62135596801, 10 ** 17, 67767976233532799, 67767976233532800,
          67768036191676799, 67768036191676800, -67768040609740800, -67768040609740801, -67768100567971200, 2 ** 63 - 1,
          2 ** 63, -2 ** 63, -2 ** 63 - 1, 1.5e17, 9.3e18, 1e19, -9.3e18, 253402300799.9999996, 0.5, -0.5, 1e-7, 1.0000005,
          float('nan'), float('inf'), float('-inf'), 1789746632, 1789746632.25]

COMMUNITY_RES = [
    (r'^(seeking work|for hire|looking for work)\b', re.I),
    (r'\b(no contractors?|no freelance|full[ -]?time only|part[ -]?time not available)\b', re.I),
    (r'\b(part[ -]?time|contract(?:or|ing)?|freelance|fractional)\b', re.I),
    (r'\b(?:USA?|UK|EU|Europe|Canada|Australia)\s+only\b|REMOTE\s*\((?:EU|US|USA|UK|Europe)\)|\b(?:Poland|Romania|Romanian)(?: or (?:Poland|Romania|Romanian))? residents only', re.I),
    (r'承接|接单|接單|接活|自荐|自薦|作品展示|出售|广告联盟|廣告聯盟|假如|如果', 0),
    (r'招聘|寻找|尋找|求助|需求|外包|找.{0,20}(开发|開發|工程师|工程師|大佬)|有.{0,20}项目', 0),
    (r'\b(?:LATAM|Latin America|US[- ]only|EU[- ]only)\b', re.I),
    (r'[a-z0-9_-]{1,250}', 0), (r'/t/(\d+)', 0),
    (r'\s+', 0), (r'\S+', 0), (r'\w+', 0), (r'\W', 0), (r'\D+', 0), (r'a.b', 0), (r'x$', 0), (r'^\d{2,}', 0), (r'[^\s]+', 0),
    (r'k', re.I), (r's', re.I), (r'i', re.I), (r'[ks]+', re.I), (r'[^k]', re.I), (r'\bword\b', 0), (r'a{,2}b', 0), (r'a{2}', 0),
    (r'\(x\)', 0), (r'a|b|c', 0), (r'[\d.]+', 0), (r'[-a]+', 0), (r'[a-]+', 0), (r'x{', 0), (r'(a)(b)?', 0), (r'a+?', 0),
    (r'[\]x]+', 0), (r'\.\*', 0),
]
RE_TEXT = ['Seeking work as dev', 'seeking workers', 'SEEKING WORK', 'for hire', 'We are hiring part-time', 'part time', 'parttime',
           'Part Time', 'PART-TIME', 'contracting', 'Contractor', 'contracts', 'freelancer', 'fractional CTO', 'no contractors',
           'No Contractor please', 'full-time only', 'FULLTIME ONLY', 'part time not available', 'US only', 'USA  only', 'UK only',
           'EU　only', 'Europe\nonly', 'Canada only!', 'Australiaonly', 'REMOTE (EU)', 'remote(us)', 'REMOTE  (USA)',
           'Poland residents only', 'Romania or Poland residents only', 'Romanian or Romanian residents only', 'polish residents only',
           'ſeeking work', 'Part-tİme', 'contractıng', 'K', 'k', 'K', 'ſ', 'S', 'İ', 'ı', 'i', 'I', 'café part-time',
           'éUS only', 'US onlyé', '_US only', 'US only_', 'US onlý', '招聘 Python 工程师', '找一位開發', '找' + 'x' * 20 + '开发',
           '找' + 'x' * 21 + '开发', '找\n开发', '找\r开发', '找 开发', '有个小项目', '有 项目', '承接外包', '如果招聘', 'LATAM',
           'latam remote', 'Latin  America', 'us-only', 'eu only', '/t/123', '/t/١٢٣', '/t/', '/t/12a', '/t/12\n', '/t/\U0001d7ce',
           'abc-def_1', 'ABC', 'a' * 251, 'x\n', 'x', 'x\n\n', 'a\nb', 'a b', 'a\rb', 'aab', 'b', '(x)', '12345', '١٢',
           '\U0001d7ce\U0001d7cf', ' \t\x1c\x85 ', 'word', 'sword', 'wordy', 'word²', '\U0001f600 part-time \U0001f600', '',
           'part‐time', 'part­time', '1.2.3', 'x{', 'a]x]', '.*', '-a-', 'kKſsSK', 'İı']


def re_case(pattern, flags, s):
    def span(m):
        return None if m is None else dict(span=list(m.span()), groups=list(m.groups()))
    return dict(pattern=pattern, ignorecase=bool(flags), input=s,
                search=span(re.search(pattern, s, flags)), fullmatch=span(re.fullmatch(pattern, s, flags)))


class FakeResponse:
    def __init__(self, status, body):
        self.status, self.body = status, body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n=-1):
        return self.body if n < 0 else self.body[:n]


class FakeOpener:
    """A urllib opener over a fixed {url: (status, body)} map; an unknown URL fails like a network error."""
    def __init__(self, pages):
        self.pages = pages

    def open(self, request, timeout=None):
        if request.full_url not in self.pages:
            raise OSError('unknown url ' + request.full_url)
        return FakeResponse(*self.pages[request.full_url])


def limited_body(response, deadline):
    if len(response.body) > 2000000:
        raise ValueError('Response limit')
    return response.body


class FixedNow(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW if tz is not None else NOW.replace(tzinfo=None)


def wire(pages):
    return {url: [status, body.decode('latin-1')] for url, (status, body) in pages.items()}


def jbytes(v):
    return json.dumps(v).encode()


def hima(**changes):
    """backend/tests/collection/test_himalayas.py:listing"""
    return dict(title='AI agent backend engineer', description='<p>Build AI agents and APIs</p>',
                employmentType='Contractor', locationRestrictions=[], timezoneRestrictions=[],
                pubDate=1789746632, expiryDate=1893456000,
                applicationLink='https://himalayas.app/companies/example/jobs/engineer',
                guid='https://himalayas.app/companies/example/jobs/engineer') | changes


HIMALAYAS = [
    hima(), [], None, 'x', hima(pubDate=1789746632000), hima(pubDate='2026-09-18T12:00:00Z'), hima(pubDate='2026-09-18T12:00:00'),
    hima(pubDate='2026-09-18T12:00:00+05:30'), hima(pubDate=True), hima(pubDate=None), hima(pubDate=1.5), hima(pubDate=float('nan')),
    hima(pubDate=100000000000), hima(pubDate=100000000001), hima(pubDate=1e12), hima(pubDate=1789746632000.5), hima(pubDate=-5),
    hima(pubDate=253402300800), hima(pubDate='bad'), hima(pubDate=[1]),
    hima(expiryDate=None), without(hima(), 'expiryDate'), hima(expiryDate=1), hima(expiryDate='2027-01-01T00:00:00Z'),
    hima(expiryDate='bad'), hima(expiryDate=True), hima(expiryDate='2027-01-01'),
    *[hima(locationRestrictions=v) for v in ([{'alpha2': 'US', 'name': 'United States'}], ['Taiwan'], [' TW '],
                                            [{'alpha2': '', 'name': 'Taiwan'}], [{'name': 'TAIWAN, PROVINCE OF CHINA'}], [{}], [5],
                                            [''], ['  '], None, 'US', [{'alpha2': 'US'}, 'Taiwan'], ['ΣΑΣ'], [{'alpha2': None, 'name': 'tw'}],
                                            [{'alpha2': 0, 'name': 'Japan'}], ['Taiwan　'], ['İstanbul'])],
    *[hima(timezoneRestrictions=v) for v in ([8], [8.0], ['8'], [' 8 '], ['+8.0'], [-5, 0], [True], [False], [None], [[8]], [{}],
                                            ['inf'], ['nan'], [14], [14.0000001], [-12], ['-12'], ['1_4'], ['８'], [2 ** 1100], ['abc'],
                                            None, 8, [8, -5], [7.999999999999999], ['８.0'], ['　 8'])],
    *[hima(employmentType=v) for v in ('Part Time', 'Full Time', 'Intern', None, 5, 'contractor')],
    *[hima(applicationLink=v) for v in ('https://evil.example/', None, 5, [], 'https://himalayas.app/companies/x/jobs/y?utm=1#f',
                                       'https://himalayas.app/jobs/y', 'https://himalayas.app/companies/x', 'http://himalayas.app/companies/x/jobs/y',
                                       'HTTPS://himalayas.app/companies/x/jobs/y', 'https://www.himalayas.app/companies/x/jobs/y', '', 0)],
    *[hima(title=v) for v in ('', 'x' * 501, None, '後端 \U0001f600', 'x' * 500)],
    *[hima(description=v) for v in ('', '<script>x</script>', '<p>a &amp; b</p>', None, 'x' * 100001, '<p>後端</p>')],
    *[hima(guid=v) for v in ('', None, 5, 'x' * 2001, '後端')],
]


def hima_fetch_case(pages):
    def run():
        with patch.object(himalayas, 'build_opener', lambda *a: FakeOpener(pages)), patch.object(himalayas.time, 'sleep', lambda s: None):
            return [encode(himalayas.normalize(p)) for p in himalayas.fetch()]
    return dict(pages=wire(pages), expect=attempt(run))


def hima_urls():
    from urllib.parse import urlencode
    return ['https://himalayas.app/jobs/api/search?' + urlencode(dict(q=q, employment_type=e, country='TW', sort='recent', page=1))
            for q in himalayas.QUERIES for e in ('Contractor', 'Part Time')]


def hima_pages(*overrides, default=None):
    urls = hima_urls()
    pages = {u: (200, jbytes({'jobs': []} if default is None else default)) for u in urls}
    for i, value in overrides:
        pages[urls[i]] = value
    return pages


A, B = 'https://himalayas.app/companies/a/jobs/a', 'https://himalayas.app/companies/b/jobs/b'
HIMALAYAS_FETCH = [
    hima_pages(), hima_pages(default={'jobs': [hima()]}),
    hima_pages((0, (200, jbytes({'jobs': [hima(guid=A, applicationLink=A)]}))), (3, (200, jbytes({'jobs': [hima(guid=B, applicationLink=B)]}))),
               (5, (200, jbytes({'jobs': [hima(guid=A, applicationLink=A, title='Updated title')]})))),
    hima_pages((2, (200, jbytes({'jobs': [hima(guid=str(n), applicationLink=A) for n in range(21)]})))),
    hima_pages((2, (200, jbytes({'jobs': [hima(guid=str(n), applicationLink=A) for n in range(20)]})))),
    hima_pages((1, (200, jbytes([])))), hima_pages((1, (500, b'{}'))), hima_pages((1, (200, b'not json'))),
    hima_pages((1, (200, jbytes({'jobs': None})))), hima_pages((1, (200, jbytes({'jobs': [without(hima(), 'guid')]})))),
    hima_pages((1, (200, jbytes({'jobs': [hima(guid=5)]})))), hima_pages((1, (200, jbytes({'jobs': ['x']})))),
    hima_pages((1, (200, b' ' * 8000001))), hima_pages((1, (200, b'{"jobs": [], "x": ' + b'1' * 4301 + b'}'))),
    hima_pages((1, (200, b'{"jobs": [], "x": -' + b'1' * 4300 + b'}'))), hima_pages((1, (200, jbytes({'jobs': [hima(description='')]})))),
    {u: v for u, v in list(hima_pages().items())[:7]},
]


def gob(**changes):
    """backend/tests/collection/test_getonboard.py:listing, with a fixed publication time."""
    attrs = dict(title='Part time AI agent backend engineer', description='<p>Build an AI agent and API.</p>',
                 modality={'data': {'id': 42}}, remote=True, remote_modality='fully_remote',
                 countries=['Remote'], published_at=1789746632,
                 category_name='Programming', lang='en', min_salary=1000, max_salary=2000) | changes
    return dict(id='acme-ai-agent', attributes=attrs, links={'public_url': 'https://www.getonbrd.com/jobs/acme-ai-agent'})


def gob_item(**changes):
    return gob() | changes


MOD = {'42': 'part_time', '43': 'full_time', '44': 'freelance', '45': 'internship', '46': None, '47': ['x'], '42.0': 'part_time', 'None': 'freelance'}
GETONBOARD = [
    gob(), [], None, gob_item(id='ACME'), gob_item(id='a' * 251), gob_item(id=5), gob_item(id=None), gob_item(id='a b'), gob_item(id='acme\n'),
    gob_item(attributes=None), gob_item(attributes=[]), without(gob(), 'links'), gob_item(links=None), gob_item(links={'public_url': None}),
    gob_item(links={'public_url': 5}), gob_item(links={'public_url': []}), gob_item(links={}), gob_item(links={'public_url': 'https://www.getonbrd.com/jobs/other'}),
    gob_item(links={'public_url': 'https://www.getonbrd.com/jobs/acme-ai-agent?x=1#f'}), gob_item(links={'public_url': 'https://getonbrd.com/jobs/acme-ai-agent'}),
    *[gob(title=v) for v in (None, '', '<b>x</b> &amp; y', 'Backend LATAM', 'latam', 'US-only role', 'EU only', 'Latin  America', 'x' * 501,
                             'Latin Americá', 'ſome US only', 'Remote (US Only)')],
    *[gob(description=v) for v in (None, '', '<p>a</p>' * 3, 'x' * 100001)],
    gob(projects='<p>p</p>'), gob(functions=0), gob(desirable=5), gob(benefits=[]), gob(benefits=['x']), gob(projects='p', benefits='<li>b</li>'),
    gob(projects='x' * 99990),
    *[gob(published_at=v) for v in (0, -1, True, '1789746632', 1.5e9, 2 ** 63, 10 ** 17, 253402300800, 253402300799)],
    *[gob(modality=v) for v in ({'data': {'id': '42'}}, {'data': {'id': 42.0}}, None, {}, {'data': None}, {'data': {'id': [42]}},
                                {'data': {'id': 43}}, {'data': {'id': 44}}, {'data': {'id': 45}}, {'data': {'id': 46}}, {'data': {'id': 47}},
                                {'data': {'id': True}}, {'data': {'id': 99}}, [])],
    *[gob(countries=v) for v in (None, [5], [], ['Chile', 'Remote'], 'Chile')],
    gob(remote=1), gob(remote='true'), gob(remote_modality=None), gob(category_name=['x']), gob(lang=None), gob(min_salary=1.5, max_salary=None),
    gob(title='後端 \U0001f600 工程師'), gob(extra={'nested': [1, 2.5, None]}),
]


def gob_fetch_case(pages):
    def run():
        with patch.object(getonboard, 'build_opener', lambda *a: FakeOpener(pages)), patch.object(getonboard, 'read_body', limited_body), \
                patch.object(getonboard.time, 'sleep', lambda s: None):
            r = getonboard.fetch()
        return dict(result=encode({k: v for k, v in r.items() if k != 'jobs'}), jobs=[encode(j) for j in r['jobs']])
    return dict(pages=wire(pages), expect=attempt(run))


def gob_pages(taxonomy=None, *pages):
    from urllib.parse import urlencode
    root = getonboard.ROOT
    out = {root + 'modalities?' + urlencode({'per_page': 120, 'page': 1}):
           (200, jbytes(taxonomy if taxonomy is not None else {'data': [{'id': '42', 'attributes': {'locale_key': 'part_time'}}], 'meta': {'total_pages': 1}}))}
    for n, page in enumerate(pages, 1):
        out[root + 'search/jobs?' + urlencode({'remote': 'true', 'per_page': 120, 'page': n})] = page if isinstance(page, tuple) else (200, jbytes(page))
    return out


def gpage(n, total, *items):
    return {'data': list(items), 'meta': {'page': n, 'total_pages': total}}


GETONBOARD_FETCH = [
    gob_pages(None, gpage(1, 1, gob(), gob(title=None))), gob_pages(None, gpage(1, 2, gob()), gpage(2, 2)),
    gob_pages({'data': [], 'meta': {'total_pages': 2}}, gpage(1, 1)), gob_pages({'data': [], 'meta': {'total_pages': 1.0}}, gpage(1, 1, gob())),
    gob_pages({'data': [{'id': 42, 'attributes': {'locale_key': 'part_time'}}], 'meta': {'total_pages': True}}, gpage(1, 1, gob())),
    gob_pages({'data': [], 'meta': None}, gpage(1, 1)), gob_pages({'data': []}, gpage(1, 1)),
    gob_pages(None, gpage(2, 1)), gob_pages(None, {'data': [], 'meta': {'page': '1', 'total_pages': 1}}), gob_pages(None, {'data': [], 'meta': {'page': 1.0, 'total_pages': 1}}),
    gob_pages(None, gpage(1, True)), gob_pages(None, gpage(1, -1)), gob_pages(None, gpage(1, 0, gob())), gob_pages(None, gpage(1, 1.0)),
    gob_pages(None, *[gpage(n, 20, gob_item(id=f'job-{n}', links={'public_url': f'https://www.getonbrd.com/jobs/job-{n}'})) for n in range(1, 11)]),
    gob_pages(None, {'data': [gob()] * 121, 'meta': {'page': 1, 'total_pages': 1}}), gob_pages(None, gpage(1, 1, gob(), gob())),
    gob_pages({'data': [{'id': '42'}], 'meta': {'total_pages': 1}}, gpage(1, 1)), gob_pages({'data': ['x'], 'meta': {'total_pages': 1}}, gpage(1, 1)),
    gob_pages({'data': [{'id': '42', 'attributes': {'locale_key': 'a'}}, {'id': 42, 'attributes': {'locale_key': 'part_time'}}], 'meta': {'total_pages': 1}}, gpage(1, 1, gob())),
    gob_pages(None, gpage(1, 1, gob(published_at=10 ** 17))), gob_pages(None, gpage(1, 1, gob(published_at=253402300800))),
    gob_pages(None, (500, b'{}')), gob_pages(None, (200, b'nope')), gob_pages(None, (200, b'[]')), gob_pages(None, (200, b' ' * 2000001)),
    gob_pages(None, gpage(1, 1, 'x', 5, None, gob())), gob_pages(None, {'data': None, 'meta': {'page': 1, 'total_pages': 1}}),
    gob_pages(None, {'meta': {'page': 1, 'total_pages': 1}, 'data': [], 'extra': 1}), gob_pages(None, {'data': [], 'meta': []}),
]

HN_COMMENT = dict(id=1001, time=1789746632, type='comment', parent=900,
                  text='<p>Acme | Part-time contract | Remote</p><p>Build an AI agent API.</p>')


def hn(**changes):
    return HN_COMMENT | changes


HN = [
    (hn(), 900), (hn(), 900.0), (hn(), 901), (hn(), True), (None, 900), ([], 900), (hn(deleted=True), 900), (hn(dead=1), 900), (hn(dead=0), 900),
    (hn(type='story'), 900), (without(hn(), 'type'), 900), (hn(parent=900.0), 900), (without(hn(), 'parent'), None), (hn(text=None), 900), (hn(text=5), 900),
    (hn(id='1001'), 900), (hn(id=True), 900), (hn(time=1.5), 900), (hn(time=None), 900), (hn(time=10 ** 17), 900), (hn(time=253402300800), 900),
    *[(hn(text=t), 900) for t in RE_TEXT],
    (hn(text='Location: Taipei\nRemote: yes\nWilling to relocate: no\nfreelance'), 900), (hn(text='Location: x freelance Willing to relocate: y'), 900),
    (hn(text='x Location: y Willing to relocate: freelance'), 900), (hn(text='<p>Seeking work</p> freelance'), 900),
    (hn(text='Acme | contract | ' + '\U0001f600' * 200), 900), (hn(text='part-time ' + 'x' * 100001), 900), (hn(text='<p></p>'), 900),
    (hn(text='Acme | Part-time | USA only'), 900), (hn(text='Acme | contract | REMOTE (EU)'), 900),
    (hn(text='Acme | freelance | Romania or Poland residents only'), 900), (hn(text='Acme | freelance | &lt;b&gt; &amp; caf&eacute;'), 900),
    (hn(text='<script>part-time</script>contract'), 900), (hn(id=2 ** 70), 900), (hn(), [900]), (hn(), {'a': 1}),
]


def hn_case(p, parent):
    def run():
        j = community_jobs.hn_job(p, parent)
        return None if j is None else encode(j)
    return dict(p=tag(p), parent=tag(parent), expect=attempt(run))


ATOM_NS = 'http://www.w3.org/2005/Atom'


def entry(title='招聘 Python 工程师', href='https://www.v2ex.com/t/123456#reply3', rel='alternate', published='2026-09-27T12:00:00Z',
          content='&lt;p&gt;需要 API 開發&lt;/p&gt;', links=None, extra=''):
    parts = []
    if title is not None:
        parts.append(f'<title>{title}</title>')
    if links is None:
        links = [f'<link rel="{rel}" type="text/html" href="{href}"/>'] if href is not None else [f'<link rel="{rel}"/>']
    parts.extend(links)
    if published is not None:
        parts.append(f'<published>{published}</published>')
    if content is not None:
        parts.append(f'<content type="html">{content}</content>')
    return '<entry>' + ''.join(parts) + extra + '</entry>'


def atom(*entries, head='<?xml version="1.0" encoding="UTF-8"?>', ns=ATOM_NS):
    return f'{head}<feed xmlns="{ns}"><title>V2EX</title>{"".join(entries)}</feed>'


V2EX = [
    atom(entry()), atom(), atom(entry(), entry(href='https://www.v2ex.com/t/2')), atom(entry(title='承接外包')), atom(entry(title='如果招聘')),
    atom(entry(title='hello')), atom(entry(title='找一個 Python 開發')), atom(entry(title='找' + 'x' * 21 + '開發')), atom(entry(title='有小项目')),
    atom(entry(title=None)), atom(entry(title='')), atom(entry(title='招聘 &amp; 外包')), atom(entry(title='招聘' + 'x' * 600)),
    atom(entry(links=[])), atom(entry(links=['<link rel="alternate" href="https://www.v2ex.com/t/1"/>', '<link rel="alternate" href="https://www.v2ex.com/t/2"/>'])),
    atom(entry(rel='self')), atom(entry(href=None)), atom(entry(links=['<link rel="self" href="https://x/"/>', '<link rel="alternate" href="https://www.v2ex.com/t/9"/>'])),
    *[atom(entry(href=h)) for h in ('http://www.v2ex.com/t/1', 'https://v2ex.com/t/1', 'https://www.v2ex.com/t/abc', 'https://www.v2ex.com/t/١٢٣',
                                    'https://www.v2ex.com/t/123/', 'https://www.v2ex.com/t/1?a=1&amp;b=2', 'https://www.v2ex.com/t/1&#10;',
                                    'https://www.v2ex.com/t/1&#9;x', ' https://www.v2ex.com/t/1', 'HTTPS://www.v2ex.com/t/1', 'https://www.v2ex.com/t/')],
    *[atom(entry(published=d)) for d in (None, '', '2026-09-27T12:00:00', '2026-06-01T00:00:00Z', '2026-06-30T01:00:00Z', '2026-06-30T00:59:59Z',
                                         '2026-09-27T12:00:00+08:00', 'bad', '2026-10-30T00:00:00Z')],
    atom(entry(published='2026-01-01T00:00:00Z', href='https://evil/')), atom(entry(content=None)), atom(entry(content='')),
    atom(entry(content='<div xmlns="http://www.w3.org/1999/xhtml">x<p>y</p></div>')), atom(entry(content='lead<b>x</b>tail')),
    atom(entry(content='&lt;script&gt;x&lt;/script&gt;')), atom(entry(content='x' * 100001)),
    atom(entry(links=['<link xmlns:a="urn:a" a:rel="alternate" rel="alternate" a:href="https://evil/" href="https://www.v2ex.com/t/5"/>'])),
    atom(entry(links=['<link rel=" alternate" href="https://www.v2ex.com/t/5"/>'])), atom(entry(links=['<link rel="alternate" href="https://www.v2ex.com/t/5" href2="x"/>'])),
    atom(entry(links=['<a:link xmlns:a="urn:other" rel="alternate" href="https://www.v2ex.com/t/6"/>', '<link rel="alternate" href="https://www.v2ex.com/t/7"/>'])),
    atom(entry(links=["<link rel='alternate' href='https://www.v2ex.com/t/8'/>"])),
    atom(entry(), ns='http://example.com/'), '<rss><channel/></rss>', '<!DOCTYPE feed>' + atom(entry()), '<!doctype feed>' + atom(entry()),
    atom(entry()).replace('<feed', '<!eNtItY x "y"><feed'), '<feed', atom(entry()) + 'trailing', atom(*[entry(href=f'https://www.v2ex.com/t/{n}') for n in range(100)]),
    atom(*[entry(title='hello') for _ in range(101)]), atom(entry(title='hello', content='x' * 2000000)), '\ufeff\ufeff' + atom(entry()),
    '﻿' + atom(entry()), atom(entry(title='招聘 café'), head='<?xml version="1.0" encoding="ISO-8859-1"?>'),
    atom(entry(extra='<title>second 招聘</title>')), f'<feed xmlns="{ATOM_NS}"><entry><title>招聘</title><link rel="alternate" href="https://www.v2ex.com/t/1"/><published>2026-09-27T12:00:00Z</published></entry></feed>',
    f'<a:feed xmlns:a="{ATOM_NS}"><a:entry><a:title>招聘</a:title><a:link rel="alternate" href="https://www.v2ex.com/t/3"/><a:published>2026-09-27T12:00:00Z</a:published></a:entry></a:feed>',
]


def v2ex_case(doc, raw):
    def run():
        with patch.object(community_jobs, 'datetime', FixedNow):
            return [encode(j) for j in community_jobs.v2ex_jobs(raw)]
    return dict(input=doc, expect=attempt(run))


HN_ROOT = 'https://hacker-news.firebaseio.com/v0/'
DAY = 86400
T0 = int(NOW.timestamp())


def story(i, title='Ask HN: Who is hiring? (September 2026)', age=5, kids=(), **changes):
    return dict(id=i, by='whoishiring', type='story', title=title, time=T0 - age * DAY, kids=list(kids) if isinstance(kids, (list, tuple)) else kids) | changes


def comment(i, parent, text='Acme | Part-time contract | Remote. Build an AI agent API.', **changes):
    return dict(id=i, by='someone', type='comment', parent=parent, time=T0 - DAY, text=text) | changes


def hn_pages(submitted, *items, user=None):
    pages = {HN_ROOT + 'user/whoishiring.json': (200, jbytes(user if user is not None else {'id': 'whoishiring', 'submitted': submitted}))}
    for i, item in items:
        pages[HN_ROOT + f'item/{i}.json'] = item if isinstance(item, tuple) else (200, jbytes(item))
    return pages


HN_FETCH = [
    hn_pages([1, 2, 3], (1, story(1, kids=[11, 12])), (2, story(2, title='Ask HN: Freelancer? Seeking freelancer? (September 2026)', kids=[21])),
             (3, story(3, age=70)), (11, comment(11, 1)), (12, comment(12, 1, text='Full-time only, no contractors')), (21, comment(21, 2, text='Freelance React dev wanted'))),
    hn_pages([1, 2, 3], (1, story(1, kids=[11])), (2, story(2, kids=[21])), (3, story(3, kids='bad')), (11, comment(11, 1)), (21, comment(21, 2))),
    hn_pages([1], (1, story(1, age=70))), hn_pages([1], (1, story(1, age=62))), hn_pages([1], (1, story(1, age=61))), hn_pages([], user=None),
    hn_pages(None, user={'id': 'x'}), hn_pages(None, user=[]), hn_pages([1], (1, story(1, title=None))), hn_pages([1], (1, story(1, by='other', title=None))),
    hn_pages([1], (1, without(story(1), 'time'))), hn_pages([1], (1, story(1, time='x'))), hn_pages([1], (1, story(1, time=True))),
    hn_pages([1], (1, story(1, time=float(T0)))), hn_pages([1], (1, story(1, kids=None))), hn_pages([1], (1, without(story(1), 'kids'))),
    hn_pages([1], (1, story(1, kids=['x']))), hn_pages([1], (1, story(1, kids=[0]))), hn_pages([1], (1, story(1, kids=[11])), (11, (200, b'null'))),
    hn_pages([1], (1, story(1, kids=[11])), (11, comment(11, 1, deleted=True))), hn_pages([True], (1, story(1))), hn_pages(['1'], (1, story(1))),
    hn_pages([1, 2, 3, 4, 5, 6, 'bad'], *[(n, story(n, kids=[])) for n in range(1, 7)]), hn_pages([1, 2, 3, 4, 5, 6, 7], *[(n, story(n, kids=[])) for n in range(1, 7)]),
    hn_pages([1], (1, story(1, kids=list(range(100, 205)))), *[(n, comment(n, 1, text=f'Contract role {n}')) for n in range(100, 205)]),
    hn_pages([1], (1, without(story(1, kids=[]), 'id'))), hn_pages([1], (1, without(story(1, kids=[11]), 'id')), (11, comment(11, 1))),
    hn_pages([1], (1, story(1, kids=[11])), (11, (500, b'{}'))), hn_pages([1], (1, story(1, kids=[11])), (11, (200, b' ' * 2000001))),
    hn_pages([1], (1, story(1, kids=[11])), (11, comment(11, 1, id=11.0))), hn_pages([1], (1, story(1, deleted=True))),
    hn_pages([1, 2], (1, 'x'), (2, story(2, kids=[]))), hn_pages([1], (1, story(1, type='job', kids=[]))),
]


def hn_fetch_case(pages):
    def run():
        with patch.object(community_jobs, 'build_opener', lambda *a: FakeOpener(pages)), patch.object(community_jobs, 'datetime', FixedNow):
            return [encode(j) for j in community_jobs.fetch('hackernews')]
    return dict(pages=wire(pages), expect=attempt(run))


XML_ATTRIB = ['<a x="1" y=\'2\'/>', '<a xmlns="urn:d" x="1"/>', '<a xmlns:p="urn:p" p:x="1" x="2"/>', '<a x="a&amp;b&#10;c&#9;d\n e"/>',
              '<a x=" sp  aced "/>', '<a><b k="v"/><c/></a>', '<a xml:lang="en"/>', '<a xmlns:p="urn:p"><p:b p:k="1" k="2"/></a>']


def xml_attrib_case(doc):
    import xml.etree.ElementTree as ET
    def run():
        return [[e.tag, list(e.attrib.items())] for e in ET.fromstring(doc.encode()).iter()]
    return dict(input=doc, expect=attempt(run))



# ---------------------------------------------------------------- public_feeds (step 8, batch 2)
def pf_remote(**changes):
    """backend/tests/collection/test_public_feeds.py:remote, with a fixed date"""
    return dict(id='123', position='Contract Backend API engineer', description='<p>Build API integrations.</p>',
                url='https://remoteOK.com/remote-jobs/remote-api-123', tags=['contract', 'backend'],
                date='2026-09-18T12:00:00+00:00', location='', salary_min=0, salary_max=0) | changes


def pf_nomad(**changes):
    return dict(url='https://www.workingnomads.com/job/go/123/', title='Contract AI agent engineer',
                description='<p>Build an AI agent and API.</p>', pub_date='2026-09-18T12:00:00+00:00',
                tags='python,agent', location='Anywhere', category_name='Development') | changes


def pf_rss_entry(**changes):
    return dict(title='Part-time Backend API developer', description='<p>Build API integrations.</p>',
                url='https://www.realworkfromanywhere.com/jobs/backend-123', date='Fri, 18 Sep 2026 12:00:00 GMT',
                location=None, tags=[]) | changes


WWR = 'https://weworkremotely.com/remote-jobs/company-ai-agent-123'
PF_NORMALIZE = [
    *[('remoteok', e) for e in (
        pf_remote(), [], None, 'x', pf_remote(id=123), pf_remote(id=True), pf_remote(id=False), pf_remote(id=1.0), pf_remote(id=-1),
        pf_remote(id='١٢٣'), pf_remote(id='²'), pf_remote(id=''), pf_remote(id=None), pf_remote(id=[1]), pf_remote(id='12a'),
        without(pf_remote(), 'id'), pf_remote(position=None), pf_remote(position='x' * 501), pf_remote(position='<b>x</b>' * 60),
        pf_remote(position='Full-time Contract API'), pf_remote(position='API engineer', tags=['backend']),
        pf_remote(position='Smart Contract API engineer', tags=['blockchain'], description='Build smart contracts and API integrations.'),
        pf_remote(position='API engineer', tags=[], description='Employment type: Part-time. Build APIs.'),
        pf_remote(position='API engineer', tags=[], description='Job Type： freelance; remote'),
        pf_remote(position='API engineer', tags=[], description='This position is offered on a contractor basis.'),
        pf_remote(position='API engineer', tags=[], description='The role is a part time basis role'),
        pf_remote(position='API engineer', tags=[], description='The job is offered on a freelance basis, full time hours'),
        pf_remote(position='API engineer', tags=[], description='work type:\ncontract'),
        pf_remote(position='API engineer', tags=['smart-contract']), pf_remote(position='API engineer', tags=['smart  contracts dev']),
        pf_remote(position='API engineer', tags=['part_time']), pf_remote(position='API engineer', tags=['FULL_TIME', 'contract']),
        pf_remote(position='API engineer', tags=['ſmart contract']), pf_remote(position='API engineer', tags=['contractors']),
        pf_remote(tags='contract'), pf_remote(tags=None), pf_remote(tags=[1]), without(pf_remote(), 'tags'),
        pf_remote(employment_type='Contract', tags=[]), pf_remote(employment_type=5, tags=[]), pf_remote(employment_type={'a': 1.5}, tags=[]),
        pf_remote(employment_type=['part', 'time'], tags=[]), pf_remote(employment_type=0, tags=[]), pf_remote(employment_type=True),
        pf_remote(closed=True), pf_remote(closed=1), pf_remote(closed='true'), pf_remote(status='filled'), pf_remote(status=['closed']),
        pf_remote(description='<p>This position is closed.</p>'), pf_remote(position='Job filled: contract API'),
        pf_remote(description='The listing  expired'), pf_remote(description='job is filledx'),
        pf_remote(location='Worldwide'), pf_remote(location=5), pf_remote(location=0), pf_remote(location=['US']), pf_remote(location=None),
        pf_remote(salary_min=50000, salary_max=80000.5, salary_period='year'), pf_remote(salary_min='', salary_max=None),
        pf_remote(salary_min={'x': [1]}), pf_remote(description=None), pf_remote(description=''), pf_remote(description='<script>x</script>'),
        pf_remote(description='x' * 200001),
        pf_remote(url=None), pf_remote(url=5), pf_remote(url='https://evil.example/remote-jobs/123'), pf_remote(url='https://remoteok.com/remote-jobs/'),
        pf_remote(url='http://remoteok.com/remote-jobs/x'), pf_remote(url='https://remoteok.com/jobs/x'), pf_remote(url='https://REMOTEOK.COM/remote-jobs/x?a=1#f'),
        pf_remote(url='https://remoteok.com:443/remote-jobs/x'), pf_remote(url='https://user@remoteok.com/remote-jobs/x'),
        pf_remote(url='https://[::1/remote-jobs/x'), pf_remote(url=' https://remoteok.com/remote-jobs/x\t'), pf_remote(url='https://remoteok.com/remote-jobs/\U0001f600'),
        pf_remote(url='HTTPS://remoteok.com/remote-jobs/x'), pf_remote(url='https://remoteok.com/remote-jobs/x/../y'), pf_remote(url='https://remoteoK.com/remote-jobs/x'),
        pf_remote(url='https://remoteok.comİ/remote-jobs/x'), pf_remote(url='https://remoteo\u212a.com/remote-jobs/x'),
        pf_remote(date=None), pf_remote(date=5), pf_remote(date='2026-09-18'), pf_remote(date='2026-09-18T12:00:00'), pf_remote(date='2026-09-18T12:00:00Z'),
        pf_remote(date='Fri, 18 Sep 2026 12:00:00 GMT'), pf_remote(date='Fri, 18 Sep 2026 12:00:00 -0000'), pf_remote(date='bad'),
        pf_remote(date='0001-01-01T00:00:00+01:00'), pf_remote(date='9999-12-31T23:59:59-01:00'), pf_remote(date='2026-09-18T12:00:00.123456+05:30'),
    )],
    *[('workingnomads', e) for e in (
        pf_nomad(), pf_nomad(tags=' python , ,agent,'), pf_nomad(tags=''), pf_nomad(tags=['x']), pf_nomad(tags=5), pf_nomad(tags='　a　,b'),
        pf_nomad(url='https://www.workingnomads.com/job/go/12a/'), pf_nomad(url='https://www.workingnomads.com/job/go/123'),
        pf_nomad(url='https://www.workingnomads.com/job/go/١٢٣/'), pf_nomad(url='https://www.workingnomads.com/job/go/123/?utm=1'),
        pf_nomad(url='https://workingnomads.com/job/go/123/'), pf_nomad(url='https://evil.example/job/go/124/'),
        pf_nomad(pub_date=None), without(pf_nomad(), 'pub_date'), pf_nomad(date='2026-09-18T12:00:00+00:00', pub_date=None),
        pf_nomad(title='Full time engineer'), pf_nomad(id='999'), pf_nomad(location=''),
    )],
    *[(src, e) for src in ('realworkfromanywhere', 'weworkremotely') for e in (
        pf_rss_entry(), pf_rss_entry(url=WWR), pf_rss_entry(tags=['Programming', '']), pf_rss_entry(location='Anywhere in the World'),
        pf_rss_entry(title=None), pf_rss_entry(description=None), pf_rss_entry(date=None), pf_rss_entry(date=''), pf_rss_entry(url=None),
        pf_rss_entry(url='https://www.realworkfromanywhere.com/jobs/'), pf_rss_entry(date='Fri, 18 Sep 2026 12:00:00'),
    )],
]


def pf_normalize_case(source, entry):
    # parse_batch counts ValueError/TypeError as one rejected listing; anything else fails the source.
    try:
        expect = {'ok': encode(public_feeds.normalize(source, entry))}
    except (ValueError, TypeError):
        expect = {'error': 'rejected'}
    except Exception as exc:
        expect = {'error': type(exc).__name__}
    return dict(source=source, entry=tag(entry), expect=expect)


def pf_rss(*items, head='<?xml version="1.0" encoding="UTF-8"?>', channel=True):
    body = ''.join(items)
    return head + ('<rss version="2.0"><channel><title>Jobs</title>' + body + '</channel></rss>' if channel else '<rss>' + body + '</rss>')


def pf_item(title='<![CDATA[Part-time Backend API developer]]>', description='<![CDATA[<p>Build API integrations.</p>]]>',
            link='https://www.realworkfromanywhere.com/jobs/backend-123', date='Fri, 18 Sep 2026 12:00:00 GMT', extra=''):
    return (f'<item>\n<title>{title}</title><description>{description}</description>\n<link>{link}</link>'
            f'<guid>{link}</guid><pubDate>{date}</pubDate>{extra}</item>')


PF_BATCH = [
    *[('remoteok', d) for d in (
        jbytes([{'legal': 'Link to Remote OK'}, pf_remote()]), jbytes([pf_remote()]), jbytes([{'legal': 'x', 'id': '1'}, pf_remote()]),
        jbytes([{'legal': 'x'}]), jbytes(['legal', pf_remote()]), b'', b' \t\r\n\x0b\x0c', b'{}', b'[]', b'[{"id": 1},', b'[{}', b'null',
        jbytes([pf_remote(id=str(i)) for i in range(205)]), jbytes([pf_remote(id=str(i)) for i in range(200)]), jbytes([pf_remote(id=str(i)) for i in range(201)]), jbytes([pf_remote(), pf_remote(id='2', url='https://remoteok.com/remote-jobs/')]),
        jbytes([pf_remote(), pf_remote(date='9999-12-31T23:59:59-01:00')]), jbytes([pf_remote()] * 2), b'\xef\xbb\xbf' + jbytes([pf_remote()]),
        jbytes([pf_remote()]).decode().encode('utf-16'), b' ' * 8000001, b'[' + b'1' * 4301 + b']', b'[NaN]',
        jbytes([pf_remote(salary_min=float('nan'))]), b'\x85[]',
    )],
    *[('workingnomads', d) for d in (jbytes([pf_nomad()]), jbytes([{'legal': 'x'}, pf_nomad()]), jbytes({'jobs': []}))],
    *[('realworkfromanywhere', d.encode() if isinstance(d, str) else d) for d in (
        pf_rss(pf_item()), pf_rss(pf_item(), head=''), pf_rss(pf_item(), channel=False), pf_rss(),
        pf_rss(pf_item(description='<![CDATA[<p>R&D API &amp; automation</p>]]>', extra='<enclosure url="https://example.org/logo?s=200&v=4" />')),
        pf_rss(pf_item(extra='<enclosure type="image/png" url="https://e.org/l?a=1&b=2&c" length="1"/>')),
        pf_rss(pf_item(extra='<enclosure url="https://e.org/l?a=1&amp;b=2"/>')),
        pf_rss(pf_item(extra='<!-- <enclosure url="https://e.org/l?a=1&b=2"/> --><enclosure url="x&y=1"/>')),
        pf_rss(pf_item(description='<![CDATA[<enclosure url="a&b=1"> ok]]>', extra='<enclosure url="a&b=1"/>')),
        pf_rss(pf_item(extra='<enclosure url="a&b"/>')), pf_rss(pf_item(extra='<enclosureX url="a&b=1"/>')),
        pf_rss(pf_item(extra='<enclosure\nurl="a&_b.c-d=1"/>')), pf_rss(pf_item(extra='<enclosure data-url="a&b=1"/>')),
        pf_rss(pf_item(extra='<region>Anywhere in the World</region><category>Programming</category><category/>')),
        pf_rss(pf_item(extra='<region></region>')), pf_rss(pf_item(title='')), pf_rss(pf_item(title='A<b>x</b>tail')),
        pf_rss(pf_item(description='a &amp;lt;b&amp;gt; c')),
        pf_rss(pf_item()).replace('<rss', '<!DOCTYPE rss [<!ENTITY x "boom">]><rss', 1), pf_rss(pf_item()).replace('</item>', '</wrong>'),
        pf_rss(pf_item()).replace('<pubDate>', '<pubDate>&undefined;'), pf_rss(pf_item()).replace('<rss', '<!　doctype x><rss'),
        pf_rss(pf_item()).replace('<rss', '<!-- <!ENTITY --><rss'), pf_rss(pf_item(), head='<?xml version="1.0" encoding="ISO-8859-1"?>'),
        pf_rss(pf_item(), head='<?xml version="1.0" encoding="bogus"?>'), '﻿' + pf_rss(pf_item()), '﻿﻿' + pf_rss(pf_item()),
        pf_rss(pf_item()).encode('latin-1') + b'\xff', pf_rss(pf_item(title='後端 \U0001f600 contract')), pf_rss(*[pf_item(link=f'https://www.realworkfromanywhere.com/jobs/x{i}') for i in range(201)]),
        pf_rss(pf_item(), pf_item(link='https://evil.example/jobs/x')), pf_rss(*[pf_item(link=f'https://www.realworkfromanywhere.com/jobs/x{i}') for i in range(200)]),
        pf_rss(pf_item(description='<![CDATA[<p>a\n<enclosure url="a&b=1">\nb</p>]]>', extra='<!--\n<enclosure url="c&d=1"/>\n--><enclosure url="e&f=1"/>')), pf_rss(pf_item(extra='<x:y xmlns:x="urn:x"/>')),
        pf_rss(pf_item()).replace('<channel>', '<channel xmlns="urn:d">'), '<rss/>', 'not xml', pf_rss(pf_item(title='<![CDATA[a]]>b<![CDATA[c]]>')),
    )],
]


def pf_batch_case(source, raw):
    def run():
        jobs, truncated, rejected = public_feeds.parse_batch(source, raw)
        return dict(jobs=[encode(j) for j in jobs], truncated=truncated, rejected=rejected)
    return dict(source=source, input=raw.decode('latin-1'), expect=attempt(run))


PF_RES = [
    (r'(?:employment|job|work|position)\s*type\s*[:：]\s*([^\n.;]+)', re.I, 0),
    (r'(?:position|role|job)\s+(?:is\s+)?(?:offered\s+)?(?:on\s+)?(?:a\s+)?(?:part[ -]time|freelance|contract(?:or)?)(?:\s+basis)?\b', re.I, 0),
    (r'\bsmart[ -]+contracts?\b', re.I, 0), (r'\bfull[\s_-]*time\b', re.I, 0), (r'\b(?:part[\s_-]*time|freelance|contract(?:or)?)\b', re.I, 0),
    (r'\b(?:position|job|listing)\s+(?:is\s+)?(?:closed|filled|expired)\b', re.I, 0), (r'<!\s*(?:DOCTYPE|ENTITY)\b', re.I, 0),
    (r'(<!\[CDATA\[.*?\]\]>|<!--.*?-->)', re.S, 1), (r'(<enclosure\b[^>]*\burl=")([^"]*)(")', 0, 0), (r'&(?=[A-Za-z_][A-Za-z0-9_.-]*=)', 0, 0),
    (r'/job/go/\d+/', 0, 0),
]
PF_RE_TEXT = RE_TEXT + [
    'Employment type: Part-time. More', 'JOB TYPE：freelance;x', 'work  type :\n contract', 'Position type: ', 'positiontype:x', 'work type: a\nb',
    'job type: 　x', 'The position is offered on a contract basis', 'role part-time', 'job is a contractor', 'job contractors', 'position\nis\noffered\non\na\nfreelance',
    'smart contract', 'Smart  -contracts!', 'smartcontracts', 'ſmart contract', 'full time', 'FULL_TIME', 'full-_ time', 'full\ttime', 'fulltimer', 'ﬀull time',
    'part_time', 'Part - time', 'contractor', 'Freelance', 'the job is closed', 'Listing expired', 'position  is filled.', 'jobs closed',
    '<!DOCTYPE x>', '<! doctype', '<!　ENTİTY x', '<!ENTITYx', '<!-- x -->', '<![CDATA[a]]>b<![CDATA[\nc\n]]>', '<!-- a\n-- b -->', '<![CDATA[x',
    '<enclosure url="a&b=1&c">', '<enclosure x="1" url="a&b=1"/><enclosure url="c&d=2"/>', '<enclosure\turl="">', '<enclosureurl="a">',
    'a&b=1&c&_d.e-f=2&1=x&é=1', '&=', '/job/go/123/', '/job/go/١٢٣/', '/job/go/123/x', '/job/go//',
]


def pf_re_case(pattern, flags, has_group, s):
    m = re.search(pattern, s, flags)
    return dict(pattern=pattern, ignorecase=bool(flags & re.I), dotall=bool(flags & re.S), input=s,
                search=None if m is None else dict(span=list(m.span()), groups=list(m.groups())),
                findall=re.findall(pattern, s, flags) if pattern.count('(') - pattern.count('(?') <= 1 else None,
                sub=re.sub(pattern, '', s, flags=flags), split=re.split(pattern, s, flags=flags))


def pf_xml_str_case(doc):
    import xml.etree.ElementTree as ET
    def run():
        return [[e.tag, e.text] for e in ET.fromstring(doc).iter()]
    return dict(input=doc, expect=attempt(run))


XML_STR = ['<?xml version="1.0" encoding="ISO-8859-1"?><r>é</r>', '<?xml version="1.0" encoding="UTF-16"?><r>é</r>',
           '<?xml version="1.0" encoding="cp1252"?><r>é</r>', '<?xml version="1.0" encoding="bogus"?><r>é</r>',
           '<?xml version="1.0" encoding="US-ASCII"?><r>é</r>', '﻿<r>a</r>', '﻿﻿<r>a</r>', '<r>\x00</r>',
           '<?xml version="1.1"?><r>\x85</r>', '<?xml version="1.0" encoding="UTF-8"?>﻿<r/>', ' <?xml version="1.0"?><r/>',
           '<r>\U0001f600</r>', '<r>￾</r>', '<r>&#x1F600;</r>', '<?xml version="1.0" encoding=""?><r/>']


# ---------------------------------------------------------------- step 8, batch 3: HTML JobPosting sources
from freelance.modules.collection import nodesk, justremote, dynamitejobs, jobbank518, chickpt   # noqa: E402
from urllib.error import HTTPError                                     # noqa: E402
from urllib.parse import urljoin                                       # noqa: E402
from datetime import date as _date                                     # noqa: E402

URLJOIN_BASES = ['https://justremote.co/', 'https://dynamitejobs.com', 'https://www.518.com.tw', 'https://www.chickpt.com.tw',
                 'https://a.example/b/c/d;p?q#f', 'https://a.example', '', 'http://a.example/x/']
URLJOIN_REFS = ['', 'x', '/x', 'x/y', './x', '../x', '../../../../x', '/a/../b', '/a/./b/', 'a/b/..', 'a/b/.', '.', '..', '?q', '#f',
                '?q#f', ';p', 'a;p', 'a;p/b', '//other.example/x', '//other.example', 'https://dynamitejobs.com/company/a/remote-job/b',
                'HTTPS://justremote.co/remote-developer-jobs/a', 'http://justremote.co/x', 'https:x', 'https:/x', 'mailto:a@b',
                'javascript:alert(1)', ' /x', '\t/x\n', '/a//b', 'a//b//c', '//', '///x', 'remote-developer-jobs/ai-agent-acme',
                'job-Ab1234.html', '/job-Ab1234.html?x=1#apply', 'ftp://a/b', 'g:h', '/%2e%2e/x', 'x?y/../z', 'é/ü', '　/x',
                '//[::1]/x', '//[::1/x', '../.', './..', 'a/./../b/', '/..', 'b/c/../../..', '/x/']
UPPER = ['contractor', 'Full_Time', 'ß', 'ﬀ', 'ŉ', 'ǰ', 'ΐ', 'ǅ', 'ı', 'i̇', 'straße', 'ﬁve', 'ᾳ', 'ꭰ', '\U00010428', '\U0001e922', 'ſ',
         'µ', 'ÿ', 'Σς', 'ͅ', 'ⓐ', '𐓘', '\U00016e60', 'part_time', '', 'ᲀ', 'ꞔ', 'ʂ', '\U0001e030',
         # 55 code points upper-case differently in Node's newer ICU (measured 2026-10-25); a few of them:
         'ƛ', 'ɤ', 'ᲊ', '\ua7cd', '\ua7db', '\U00010d70', '\U00016ebb', 'contractƛ']
RAW_DECODE = ['{"a": 1}', '{"a": 1};', '{"a": 1} ;', ' {"a": 1}', '\n{}', '[1, 2]x', '"s"rest', '1', '-1.5e3 ', 'NaN;', 'true', 'nul',
              '', '{', '{"a":}', '{"a": 1}{"b": 2}', '{"a": "\\u00e9"}', '﻿{}', '{"a": 1, "a": 2}', '[' * 3 + ']' * 3]
DATE_ISO = ['2026-09-26', '2026-02-29', '2028-02-29', '2026-13-01', '2026-00-10', '2026-01-00', '0000-01-01', '0001-01-01', '9999-12-31',
            '2026-1-01', '20260926', '2026-W01', '2026-W01-1', '2026W011', '2026-09-26T00:00', '２０２６-０９-２６', '2026-09-2',
            '2026/09/26', '', '2026-09-26 ', '١٢٣٤-٠١-٠١']
B3_RES = [
    (r'/remote-jobs/[a-z0-9][a-z0-9-]+/\Z', 0, 'fullmatch'), (r'/remote-[a-z-]+-jobs/[a-z0-9][a-z0-9-]+\Z', 0, 'fullmatch'),
    (r'/company/[a-z0-9-]+/remote-job/[a-z0-9-]+\Z', 0, 'fullmatch'), (r'/job-([A-Za-z0-9]{6})\.html\Z', 0, 'fullmatch'),
    (r'/job-([A-Za-z0-9]{12})\Z', 0, 'fullmatch'), (r'\d{4}-\d{2}-\d{2}', 0, 'fullmatch'),
    (r'cf-chl-|_Incapsula_Resource|captcha-container|<title>\s*(?:Just a moment|Access denied)', re.I, 'search'),
    (r'更新日期\s*[:：]\s*(\d{4}-\d{2}-\d{2})', 0, 'search'), (r'職務類別\s*(.*?)\s*職缺條件', re.S, 'search'),
    (r'單次\$([\d,]+)(?:\s*[~～]\s*\$?([\d,]+))?(?=\s|/|$)', 0, 'match'),
]
B3_RE_TEXT = ['/remote-jobs/acme-ai-agent/', '/remote-jobs/acme-ai-agent', '/remote-jobs/acme-ai-agent/\n', '/remote-jobs/-a/', '/remote-jobs/a/',
              '/remote-jobs/Acme/', '/remote-developer-jobs/ai-agent-acme', '/remote-developer-jobs/ai-agent-acme\n', '/remote--jobs/a',
              '/remote-jobs/a', '/company/example/remote-job/ai-agent-engineer', '/company/ex/remote-job/a\n', '/company//remote-job/a',
              '/job-Ab1234.html', '/job-Ab1234.html\n', '/job-Ab12345.html', '/job-Ab123４.html', '/job-Ab1234567890', '/job-Ab1234567890\n',
              '/job-Ab123456789０', '2026-09-26', '2026-09-26\n', '２０２６-０９-２６', '2026-9-26', '<title>Just a moment...</title>',
              '<TITLE>\n  just A MOMENT', '<title>Access Denied</title>', 'x cf-chl-opt', 'CF-CHL-', '_incapsula_resource', 'captcha-container',
              '<title>Attention Required</title>', '<title> Acceſs denied', '更新日期:2026-09-26', '更新日期 ： 2026-09-26', '更新日期2026-09-26',
              '更新日期：２０２６-０９-２６', '更新日期: 2026-09-2', '職務類別\nAI工程師\n職缺條件\n兼職', '職務類別 職缺條件', '職務類別AI工程師職缺條件職缺條件',
              '職務類別\n\nAPP工程師、AI工程師\n\n職缺條件', '單次$5000', '單次$3,000 ~ $5,000', '單次$3,000～5,000', '單次$5000/次', '單次$5000元',
              '單次$5000 ~', '單次$,,,', '單次$５０００', '單次$5000 ~ $', '時薪$200', '面議', '', '單次$', 'x單次$5000', '單次$5000 在家兼職',
              '單次$1,000~$2,000/次']


class UrllibOpener:
    """urllib's opener with NoRedirect over a fixed {url: (status, body)} map: other 2xx are responses,
    a redirect is NoRedirect's ValueError, any other status HTTPError; an unknown URL fails like a network error."""
    def __init__(self, pages):
        self.pages = pages

    def open(self, request, timeout=None):
        if request.full_url not in self.pages:
            raise OSError('unknown url ' + request.full_url)
        status, body = self.pages[request.full_url]
        if status in (301, 302, 303, 307, 308):
            raise ValueError('Public feed redirects are unsupported')
        if not 200 <= status < 300:
            raise HTTPError(request.full_url, status, 'error', {}, None)
        return FakeResponse(status, body)


def ld(data, *, head='', tail='', kind='application/ld+json', raw=None):
    body = raw if raw is not None else json.dumps(data)
    return (f'<html>{head}<script type="{kind}">{body}</script>{tail}</html>').encode()


ND_URL = 'https://nodesk.co/remote-jobs/acme-ai-agent/'
ND_ENTRY = {'url': ND_URL, 'published_at': '2026-09-26T00:00:00+00:00'}


def nd_post(**changes):
    """backend/tests/collection/test_nodesk.py:article"""
    return {'@type': 'JobPosting', 'title': 'AI agent developer', 'description': '<p>Build an AI agent and API.</p>',
            'employmentType': ['CONTRACTOR'], 'jobLocationType': 'TELECOMMUTE', 'datePosted': '2026-09-26',
            'applicantLocationRequirements': {'@type': 'Country', 'name': 'Anywhere'}} | changes


def nd_item(link=ND_URL, date='Sat, 26 Sep 2026 00:00:00 GMT', title='AI agent', description='AI &ndash; agent &rsquo; work'):
    return f'<item><title>{title}</title><description>{description}</description><link>{link}</link><pubDate>{date}</pubDate></item>'


def nd_feed(*items, head='', root='rss', channel_attrs=''):
    return f'{head}<{root}><channel{channel_attrs}><title>NoDesk</title>{"".join(items)}</channel></{root}>'


ND_FEEDS = [
    nd_feed(nd_item()), nd_feed(), nd_feed(nd_item(description='&unknown;')), nd_feed(nd_item()).replace('<rss>', '<!DOCTYPE rss><rss>'),
    nd_feed(nd_item(description='<![CDATA[AI &ndash; agent]]>')), nd_feed(nd_item(description='<!-- &ndash; -->x')),
    nd_feed(nd_item(description='&ndash;&rsquo;&amp;&#8211;')), nd_feed(nd_item(description='&mdash;')),
    nd_feed(nd_item(link='https://evil.example/remote-jobs/acme-ai-agent/')), nd_feed(nd_item(link='https://nodesk.co/remote-jobs/acme-ai-agent')),
    nd_feed(nd_item(link='https://NoDesk.co/remote-jobs/acme-ai-agent/')), nd_feed(nd_item(link='http://nodesk.co/remote-jobs/acme-ai-agent/')),
    nd_feed(nd_item(link=ND_URL + '?utm=1#x')), nd_feed(nd_item(link=' ' + ND_URL)), nd_feed(nd_item(link='')),
    nd_feed('<item><title>x</title><pubDate>Sat, 26 Sep 2026 00:00:00 GMT</pubDate></item>'),
    nd_feed(nd_item(date='')), nd_feed(nd_item(date='2026-09-26T00:00:00Z')), nd_feed(nd_item(date='2026-09-26')),
    nd_feed(nd_item(date='9999-12-31T23:59:59-01:00')), nd_feed(nd_item(), nd_item()), nd_feed(nd_item(), nd_item(link=ND_URL + '?x=1')),
    nd_feed(*[nd_item(link=f'https://nodesk.co/remote-jobs/job-{i}/') for i in range(21)]),
    nd_feed(*[nd_item(link=f'https://nodesk.co/remote-jobs/job-{i}/') for i in range(20)]),
    nd_feed(*[nd_item(link='https://evil.example/') for i in range(19)], nd_item(), nd_item(link='https://nodesk.co/remote-jobs/late/')),
    nd_feed(nd_item(), root='feed'), '<rss><item/></rss>', nd_feed(nd_item(), channel_attrs=' xmlns="urn:x"'),
    nd_feed(nd_item(), head='<?xml version="1.0" encoding="UTF-8"?>'), '﻿' + nd_feed(nd_item()), 'not xml', '',
    nd_feed(nd_item(title='後端 \U0001f600')), nd_feed(nd_item(link='https://nodesk.co/remote-jobs/aé/')),
]
ND_FEED_BYTES = [nd_feed(nd_item()).encode() + b'\xff', b' ' * 2_000_001]

ND_ARTICLES = [
    ld(nd_post()), ld(nd_post(employmentType='CONTRACTOR')), ld(nd_post(employmentType=['contractor'])), ld(nd_post(employmentType=['ß', 'ﬀ'])),
    ld(nd_post(employmentType=['full_time', 'part_time'])), ld(nd_post(employmentType=[])), ld(nd_post(employmentType=[1])),
    ld(nd_post(employmentType=None)), ld(nd_post(employmentType=5)), ld(nd_post(employmentType={'a': 1})),
    ld(nd_post(employmentType=['TEMPORARY', 'temporary', 'Temporary'])), ld(nd_post(employmentType=['ǅ', 'ı', 'ŉ'])), ld(nd_post(employmentType=['CONTRACTOR', 'ƛ'])),
    ld(nd_post(employmentType=['INTERN'])), ld({k: v for k, v in nd_post().items() if k != 'employmentType'}),
    ld(nd_post(title=None)), ld(nd_post(title='')), ld(nd_post(title='<b>AI</b> agent')), ld(nd_post(title='x' * 501)), ld(nd_post(title='x' * 500)),
    ld(nd_post(description='')), ld(nd_post(description=None)), ld(nd_post(description='x' * 100_001)), ld(nd_post(description='<p>a</p><p>b &amp; c</p>')),
    ld(nd_post(validThrough='2026-12-01')), ld(nd_post(validThrough=None)), ld(nd_post(validThrough=5)), ld(nd_post(validThrough='')), ld(nd_post(validThrough=['x'])),
    ld(nd_post(jobLocationType='telecommute')), ld(nd_post(jobLocationType=['TELECOMMUTE'])), ld(nd_post(jobLocationType=None)),
    ld(nd_post(applicantLocationRequirements=[{'@type': 'Country', 'name': 'Taiwan'}, 1.0, 2, None, True, float('nan')])),
    ld(nd_post(datePosted=1.5)), ld(nd_post(title='AI \\ud800 agent')), ld(nd_post(), kind='Application/LD+JSON'),
    ld(None, raw=json.dumps(nd_post()) + '</script><script type="application/ld+json">' + json.dumps(nd_post())),
    ld(None, raw=json.dumps(nd_post()) + '</script><script type="application/ld+json">' + json.dumps({'@type': 'Organization'})),
    ld(None, raw=json.dumps([nd_post()])), ld(None, raw='{bad json'), ld(None, raw=''), ld(None, raw='  ' + json.dumps(nd_post()) + '\n'),
    ld(None, raw=json.dumps(nd_post(title='R&amp;D')).replace('R&amp;D', 'R&amp;D')), ld(nd_post(**{'@type': 'jobposting'})),
    b'<html>Pay or sign in</html>', b'', b'<SCRIPT TYPE="application/ld+json">' + json.dumps(nd_post()).encode() + b'</SCRIPT>',
    b'<script type="x" type="application/ld+json">' + json.dumps(nd_post()).encode() + b'</script>',
    b'<script type="application/ld+json"/>' + json.dumps(nd_post()).encode(), b'<script type="application/ld+json">' + json.dumps(nd_post()).encode(),
    b'<!-- <script type="application/ld+json">{}</script> -->' + ld(nd_post()), b'<script>' + json.dumps(nd_post()).encode() + b'</script>',
    ld(nd_post()) + b'\xff', b'\xef\xbb\xbf' + ld(nd_post()), ld(nd_post(description='<p>' + 'y' * 99_990 + '</p>')),
    ld(nd_post(title='x\n\ny  z')), ld(None, raw=json.dumps(nd_post()) + '</script >'), ld(None, raw=json.dumps(nd_post()).replace('}', '} </script x>', 1)),
]
ND_ARTICLE_ENTRIES = [ND_ENTRY, {'url': 'https://nodesk.co.evil/remote-jobs/acme-ai-agent/', 'published_at': ND_ENTRY['published_at']},
                      {'url': ND_URL + '?q=1', 'published_at': '2026-09-01T12:00:00+05:30'}]


def classify(fn, catch, blocked=()):
    try:
        return {'ok': encode(fn())}
    except blocked:
        return {'error': 'blocked'}
    except catch:
        return {'error': 'rejected'}
    except Exception as exc:
        return {'error': type(exc).__name__}


def nd_feed_case(raw):
    def run():
        entries, rejected, truncated = nodesk.parse_feed(raw)
        return dict(entries=entries, rejected=rejected, truncated=truncated)
    return dict(input=raw.decode('latin-1'), expect=attempt(run))


JR_URL = 'https://justremote.co/remote-developer-jobs/ai-agent-acme'


def jr_entry(**changes):
    """backend/tests/collection/test_justremote.py:entry"""
    return dict(id=42, title='AI agent API engineer', job_type='contract', category='developer',
                is_active=True, location_restrictions=[], href='remote-developer-jobs/ai-agent-acme') | changes


def jr_state(entries, status='success'):
    return {'jobsState': {'entity': {'all': entries}, 'meta': {'status': status}}}


def jr_index(data, *, prefix='window.__PRELOADED_STATE__ = ', suffix=';', extra=''):
    return (f'<html>{extra}<script>{prefix}' + (data if isinstance(data, str) else json.dumps(data)) + f'{suffix}</script></html>').encode()


JR_INDEXES = [
    jr_index(jr_state([jr_entry(), jr_entry(id=43, href='https://evil.example/x')])), jr_index(jr_state([jr_entry()]), suffix=''),
    jr_index(jr_state([jr_entry()]), suffix=' ; \n'), jr_index(jr_state([jr_entry()]), suffix=';;'), jr_index(jr_state([jr_entry()]), suffix=';alert(1)'),
    jr_index(jr_state([jr_entry()]), prefix='window.__PRELOADED_STATE__ =  '), jr_index(jr_state([jr_entry()]), prefix='\n  window.__PRELOADED_STATE__ = '),
    jr_index(jr_state([jr_entry()]), prefix='window.__PRELOADED_STATE__=') , jr_index(jr_state([jr_entry()]), extra='<script>var x = 1;</script>'),
    jr_index(jr_state([jr_entry()]), extra='<script>window.__PRELOADED_STATE__ = {};</script>'), b'<h1>No jobs</h1>',
    jr_index(jr_state([jr_entry()], status='loading')), jr_index(jr_state([])), jr_index(jr_state({'a': 1})), jr_index({'jobsState': {}}),
    jr_index({'jobsState': {'entity': {'all': [jr_entry()]}}}), jr_index({'jobsState': {'entity': {'all': [jr_entry()]}, 'meta': None}}),
    jr_index([1]), jr_index(jr_state([jr_entry(id=i + 1) for i in range(2001)])), jr_index(jr_state([jr_entry(id=i + 1, href=f'remote-developer-jobs/a-{i}') for i in range(3)])),
    jr_index(jr_state([jr_entry(id=v) for v in (True, 0, -1, '42', 1.0, None)] + [jr_entry(id=7)])),
    jr_index(jr_state([jr_entry(job_type=v) for v in ('freelance', None, 'Contract')] + [jr_entry(job_type='permanent')])),
    jr_index(jr_state([jr_entry(id=i + 1, location_restrictions=v) for i, v in enumerate(([' '], [5], 'US', None, ['Taiwan', 'US'], [''], ['　']))])),
    jr_index(jr_state([jr_entry(id=1, category=5), jr_entry(id=2, is_active=1), jr_entry(id=3, is_active=None), jr_entry(id=4, category='marketing')])),
    jr_index(jr_state([jr_entry(id=i + 1, href=v) for i, v in enumerate((
        '/remote-developer-jobs/xy', '//justremote.co/remote-developer-jobs/xy', 'https://justremote.co/remote-developer-jobs/XY',
        'https://justremote.co/remote-developer-jobs/xy?utm=1#f', 'https://justremote.co.evil.example/remote-developer-jobs/a-b',
        'http://justremote.co/remote-developer-jobs/xy', None, 5, '../remote-developer-jobs/xy', 'remote-jobs/xy', 'remote-developer-jobs/xy/',
        'remote--jobs/xy', 'remote-developer-jobs/-x', 'remote-developer-jobs/x', 'HTTPS://JUSTREMOTE.CO/remote-developer-jobs/xy'))])),
    jr_index(jr_state([jr_entry(id=1, title=''), jr_entry(id=2, title=None), jr_entry(id=3, title='<b>x</b>'), jr_entry(id=4)])),
    jr_index(jr_state([jr_entry(), jr_entry()])), jr_index(jr_state([[1], 'x', None, jr_entry()])), jr_index(jr_state([jr_entry(url='https://old.example/')])),
    jr_index(jr_state([jr_entry()])) + b'\xff', jr_index('{"jobsState": {"entity": {"all": [' + json.dumps(jr_entry()) + ']}, "meta": {"status": "success"}}} '),
    jr_index(jr_state([jr_entry()])).replace(b'<script>', b'<script type="text/javascript">'),
]


def jr_index_case(raw):
    def run():
        entries, rejected = justremote.parse_index(raw)
        return dict(entries=[encode(e) for e in entries], rejected=rejected)
    return dict(input=raw.decode('latin-1'), expect=attempt(run))


def jr_detail(**changes):
    """backend/tests/collection/test_justremote.py:detail, with a fixed date"""
    data = {'@type': 'JobPosting', 'title': 'AI agent API engineer', 'description': '<p>Build an AI agent API</p>',
            'employmentType': 'CONTRACTOR', 'datePosted': '2026-09-26T10:00:00+00:00', 'jobLocationType': 'TELECOMMUTE'} | changes
    return ('<script type="application/ld+json">' + json.dumps(data) + '</script>').encode()


JR_ARTICLES = [
    (jr_detail(), jr_entry()), (jr_detail(title='Different job'), jr_entry()), (jr_detail(title='<b>AI agent</b> API  engineer'), jr_entry()),
    (jr_detail(employmentType='FULL_TIME'), jr_entry(job_type='permanent')), (jr_detail(), jr_entry(job_type='permanent')),
    (jr_detail(employmentType='FULL_TIME'), jr_entry()), (jr_detail(employmentType=['PART_TIME', 'CONTRACTOR']), jr_entry()),
    (jr_detail(employmentType=['part_time']), jr_entry()), (jr_detail(employmentType=None), jr_entry()), (jr_detail(employmentType=[None]), jr_entry()),
    (jr_detail(validThrough=''), jr_entry()), (jr_detail(validThrough=0), jr_entry()), (jr_detail(validThrough=[]), jr_entry()),
    (jr_detail(validThrough='bad'), jr_entry()), (jr_detail(validThrough='2026-12-01T00:00:00Z'), jr_entry()), (jr_detail(validThrough=5), jr_entry()),
    (jr_detail(datePosted=None), jr_entry()), (jr_detail(datePosted='2026-09-26'), jr_entry()), (jr_detail(datePosted='Sat, 26 Sep 2026 10:00:00 +0800'), jr_entry()),
    *[(jr_detail(), jr_entry(location_restrictions=v)) for v in (['Taiwan'], ['United States'], ['ASIA'], ['Europe', 'Worldwide'], ['İstanbul'], ['TAIWAN, PROVINCE OF CHINA'], [' Taiwan'])],
    (jr_detail(jobLocationType='REMOTE'), jr_entry()), (jr_detail(), jr_entry(is_active=False)), (jr_detail(), jr_entry(category='marketing')),
    (jr_detail(description=''), jr_entry()), (jr_detail(title='x' * 501), jr_entry(title='x' * 501)),
    (jr_detail(), {k: v for k, v in jr_entry().items() if k != 'title'}), (b'<h1>none</h1>', jr_entry()), (jr_detail() + b'\xff', jr_entry()),
    (jr_detail(), jr_entry(url='https://evil.example/x')),
]


def jr_article_entry(e):
    if 'url' not in e:
        e = e | {'url': justremote.canonical(e['href'])}
    return e


DJ_URL = 'https://dynamitejobs.com/company/example/remote-job/ai-agent-engineer'


def dj_post(**changes):
    """backend/tests/collection/test_dynamitejobs.py:detail, with a fixed date"""
    return {'@type': 'JobPosting', 'title': 'AI agent API engineer', 'description': '<p>Build an AI agent API.</p>',
            'url': DJ_URL, 'employmentType': 'CONTRACTOR', 'jobLocationType': 'TELECOMMUTE',
            'applicantLocationRequirements': [{'@type': 'Country', 'name': 'Taiwan'}],
            'datePosted': '2026-09-26T10:00:00+00:00'} | changes


def links(*hrefs, tag='a'):
    return ''.join(f'<{tag} href="{h}">job</{tag}>' if h is not None else f'<{tag} href>job</{tag}>' for h in hrefs).encode()


DJ_INDEXES = [
    links(DJ_URL, DJ_URL), links('/company/a/remote-job/b', DJ_URL + '?utm=1#x'), links('/category/development', DJ_URL), links('/remote-job/', DJ_URL),
    links('https://evil.example/company/a/remote-job/b'), b'<h1>No recognized jobs</h1>', b'<a>x</a>' + links(DJ_URL), links(None, DJ_URL),
    links(DJ_URL, tag='link'), links(*[f'/company/a/remote-job/j{i}' for i in range(201)]), links(*[f'/company/a/remote-job/j{i}' for i in range(200)]),
    b'<title>Just a moment...</title>' + links(DJ_URL), links(DJ_URL) + b'<div class="cf-chl-widget"></div>', b'<TITLE> access DENIED</TITLE>' + links(DJ_URL),
    b'', links(DJ_URL) + b'\xff', links('HTTPS://DYNAMITEJOBS.COM/company/a/remote-job/b'), links('//dynamitejobs.com/company/a/remote-job/b'),
    links('company/a/remote-job/b'), b'<a href="' + DJ_URL.encode() + b'"/>', links(DJ_URL.replace('ai-agent', 'AI-agent')),
]
DJ_ARTICLES = [
    ld(dj_post()), ld(dj_post(url=DJ_URL + '-other')), ld(dj_post(url='/company/example/remote-job/ai-agent-engineer')), ld(dj_post(url=None)),
    ld(dj_post(description='')), ld(dj_post(applicantLocationRequirements='Worldwide')), ld(dj_post(datePosted='yesterday')), ld(dj_post(employmentType=None)),
    ld(dj_post(employmentType=[])), ld(dj_post(employmentType=['CONTRACTOR', 'CONTRACTOR'])), ld(dj_post(employmentType=['PART_TIME', 'FULL_TIME'])),
    ld(dj_post(employmentType=['contractor'])), ld(dj_post(title='Contract AI agent engineer', employmentType='FULL_TIME')),
    ld(dj_post(applicantLocationRequirements={'@type': 'Country', 'name': 'United States'})), ld(dj_post(applicantLocationRequirements=[])),
    ld({k: v for k, v in dj_post().items() if k != 'applicantLocationRequirements'}), ld(dj_post(applicantLocationRequirements=None)),
    ld(dj_post(applicantLocationRequirements=[{'@type': 'Place', 'name': 'x'}])), ld(dj_post(applicantLocationRequirements=[{'@type': 'Country', 'name': ''}])),
    ld(dj_post(applicantLocationRequirements=[{'@type': 'Country', 'name': '<b>Taiwan</b>'}])), ld(dj_post(applicantLocationRequirements=['Taiwan'])),
    ld(dj_post(applicantLocationRequirements=[{'@type': ['Country'], 'name': 'Taiwan'}])),
    ld(dj_post(applicantLocationRequirements=[{'@type': 'AdministrativeArea', 'name': 'APAC'}, {'@type': 'Country', 'name': 'Japan'}])),
    ld(dj_post(applicantLocationRequirements=[{'@type': 'Country', 'name': 'Germany'}, {'@type': 'Country', 'name': 'Canada'}])),
    ld(dj_post(validThrough='')), ld(dj_post(validThrough=None)), ld(dj_post(validThrough=0)), ld(dj_post(validThrough='bad')),
    ld(dj_post(validThrough='2026-12-01T00:00:00+08:00')), ld(dj_post(jobLocationType=None)), ld(dj_post(), head='<title>Just a moment</title>'),
    ld(dj_post(title='x' * 501)), ld(None, raw='[' + json.dumps(dj_post()) + ']'), b'<h1>Missing metadata</h1>',
]


def dj_index_case(raw):
    return dict(input=raw.decode('latin-1'), expect=attempt(lambda: dynamitejobs.parse_index(raw)))


JB_URL = 'https://www.518.com.tw/job-Ab1234.html'


def jb_index(*urls, empty=False, heading=None):
    """backend/tests/collection/test_jobbank518.py:index"""
    head = heading if heading is not None else '、'.join(jobbank518.CATEGORIES) + ' 的兼職工作職缺'
    return ('<h1>' + head + '</h1>' + ''.join(f'<a href="{u}">job</a>' for u in urls) +
            ('<p>抱歉沒有搜到適合的職缺</p>' if empty else '')).encode()


def jb_post(**changes):
    return {'@type': 'JobPosting', 'title': '兼職 AI agent API 工程師',
            'description': '<p>開發 AI agent API</p><br>職務類別<br>AI工程師<br>職缺條件<br>兼職',
            'url': JB_URL, 'employmentType': ['PART_TIME'], 'datePosted': '2026-01-01',
            'jobLocation': {'address': {'addressCountry': 'TW'}},
            'baseSalary': {'currency': 'TWD', 'value': {'minValue': 500, 'unitText': 'HOUR'}}} | changes


def jb_detail(data=None, *, update='<time>更新日期:2026-09-26</time>', extra=None):
    """backend/tests/collection/test_jobbank518.py:detail"""
    return (update + '<script type="application/ld+json">' + json.dumps([data or jb_post(), {'@type': 'BreadcrumbList'}] + (extra or [])) + '</script>').encode()


# 518's live index carried an ld+json with a raw control character (2026-10-25); only detail pages decode it.
JB_BAD_SCRIPTS = [b'{"@type": "ItemList", "name": "a\x01b"}', b'{"@type": "ItemList",', b'', b'[{"@type": "JobPosting"}] x']
JB_INDEXES = [
    jb_index(empty=True), b'<h1>No data</h1>', jb_index(), jb_index(JB_URL, empty=True), jb_index(JB_URL).replace('兼職'.encode(), '全職'.encode()),
    jb_index(JB_URL, JB_URL, 'https://www.tasker.com.tw/job-Ab1234.html'), jb_index(JB_URL, '/job-Ab1235.html?x=1', 'job-index.html', '#top'),
    jb_index(*[f'/job-A{i:05d}.html' for i in range(201)]), jb_index(JB_URL, heading='AI工程師 的兼職工作職缺'),
    b'<h1>' + '、'.join(jobbank518.CATEGORIES).encode() + b'</h1><h1>\xe7\x9a\x84\xe5\x85\xbc\xe8\x81\xb7\xe5\xb7\xa5\xe4\xbd\x9c\xe8\x81\xb7\xe7\xbc\xba</h1><a href="/job-Ab1234.html">x</a>',
    jb_index(heading='<span>' + '、'.join(jobbank518.CATEGORIES) + '</span> 的兼職工作職缺') + b'<a href="/job-Ab1234.html">x</a>',
    jb_index(JB_URL) + b'<script>var t = "\xe6\x8a\xb1\xe6\xad\x89\xe6\xb2\x92\xe6\x9c\x89\xe6\x90\x9c\xe5\x88\xb0\xe9\x81\xa9\xe5\x90\x88\xe7\x9a\x84\xe8\x81\xb7\xe7\xbc\xba";</script>',
    jb_index(empty=True) + b'<a href>bare</a>', b'<title>Just a moment</title>' + jb_index(JB_URL), jb_index(JB_URL) + b'\xff',
    jb_index('HTTPS://www.518.com.tw/job-Ab1234.html', 'https://www.518.com.tw/job-Ab12.html'),
    *[jb_index(JB_URL) + b'<script type="application/ld+json">' + s + b'</script>' for s in JB_BAD_SCRIPTS],
]
JB_ARTICLES = [
    jb_detail(), jb_detail(jb_post(url=JB_URL.replace('Ab1234', 'Ab1235'))), jb_detail(jb_post(description='')), jb_detail(jb_post(employmentType=None)),
    jb_detail(jb_post(datePosted='bad')), jb_detail(jb_post(employmentType=['FULL_TIME', 'PART_TIME'])), jb_detail(jb_post(employmentType='TEMPORARY')),
    jb_detail(jb_post(description='網站文案<br>職務類別<br>網站行銷企劃<br>職缺條件<br>兼職')), jb_detail(jb_post(description='<p>no category</p>')),
    jb_detail(jb_post(description='x<br>職務類別<br>APP工程師、軟體設計工程師<br>其他<br>職缺條件<br>y')),
    *[jb_detail(jb_post(datePosted=v)) for v in ('2026-01-01T00:00:00+08:00', '2026-02-30', '0000-01-01', '20260101', 5, None, '２０２６-０１-０１',
                                                 'Thu, 01 Jan 2026 00:00:00 +0800', '2026-01-01 ', '2026-W01-1')],
    *[jb_detail(update=u) for u in ('', '<time>更新日期：2026-09-26</time>', '<time>更新日期 : 2026-13-01</time>', '<time>更新日期:２０２６-０９-２６</time>',
                                    '<p>更新日期</p><p>2026-09-26</p>', '<script>更新日期:2026-09-26</script>', '<time>更新日期:2026-9-26</time>')],
    *[jb_detail(jb_post(validThrough=v)) for v in ('2026-12-31', '', None, 0, 'bad', '2026-12-31T23:59:59Z')],
    jb_detail(jb_post(jobLocationType='TELECOMMUTE', jobLocation=None, baseSalary=[1.5, 2])), jb_detail(extra=[jb_post()]),
    ('<script type="application/ld+json">' + json.dumps(jb_post()) + '</script>').encode(),
    ('<script type="application/ld+json">' + json.dumps([1, 'x', None]) + '</script>').encode(), b'<h1>Removed</h1>',
    b'<title>Access denied</title>' + jb_detail(), jb_detail(jb_post(title='x' * 501)),
    *[jb_detail() + b'<script type="application/ld+json">' + s + b'</script>' for s in JB_BAD_SCRIPTS],
]


def jb_index_case(raw):
    return dict(input=raw.decode('latin-1'), expect=attempt(lambda: jobbank518.parse_index(raw)))


CK_URL = 'https://www.chickpt.com.tw/job-Ab1234567890'


def ck_index(*urls, total=None, title='<span>電腦</span>接案任務', count_attr='id="job-count"', extra=''):
    """backend/tests/collection/test_chickpt.py:index"""
    return ('<h1>' + title + f'</h1><span {count_attr}>' + str(len(urls) if total is None else total) +
            '</span><ul id="job-list">' + ''.join(f'<li><a href="{u}">task</a></li>' for u in urls) + '</ul>' + extra).encode()


def ck_detail(salary='單次$5000', body='Build an AI agent API', url=CK_URL, *, og=None, extra='', title='AI agent 開發', prefix='任務內容'):
    """backend/tests/collection/test_chickpt.py:detail"""
    meta = og if og is not None else f'<meta property="og:url" content="{url}">'
    return (f'{meta}<h1 id="job-h1-title">{title}</h1>'
            f'<div class="job_salary_address-block"><h2>{salary}</h2><h2>在家兼職</h2></div>'
            f'<section class="job-content"><p>{prefix}</p><ul><li>{body}</li></ul></section>'
            '<section class="job-work_time">工作日期：2026/09/20~2026/10/20</section>'
            f'{extra}<section class="similar"><p>無薪 FULL_TIME unrelated advertisement</p></section>').encode()


CK_INDEXES = [
    ck_index(), ck_index(URL := CK_URL) + f'<a href="{CK_URL}extra">similar</a>'.encode(), ck_index(total=1), ck_index(CK_URL, total=0),
    ck_index(CK_URL).replace('電腦'.encode(), '其他'.encode()), b'<h1>Unavailable</h1>', ck_index(CK_URL, total=2), ck_index(CK_URL, CK_URL),
    ck_index(CK_URL, '/job-Ab1234567891?from=list'), ck_index('https://evil.example/job-Ab1234567890'), ck_index('/ajax/jobs'),
    ck_index(CK_URL, total='²'), ck_index(CK_URL, total='١'), ck_index(CK_URL, total=' 1 '), ck_index(CK_URL, total=''), ck_index(CK_URL, total='1.0'),
    ck_index(CK_URL, total='9' * 4301), ck_index(title='電腦 接案任務'), ck_index(title='電腦　接案任務'), ck_index(title='電腦接案任務<script>x</script>'),
    ck_index(CK_URL, count_attr='id="job-count" id="other"'), ck_index(CK_URL, extra='<div class>x</div>'), ck_index(CK_URL, extra='<ul id="job-list"><li><a href>x</a></li></ul>'),
    ck_index(*[f'/job-Ab{i:010d}' for i in range(201)]), b'<title>Just a moment</title>' + ck_index(), ck_index() + b'\xff', b'',
    ck_index(CK_URL, extra='<div id="job-list"><p><a href="' + CK_URL.encode().decode() + '">dup</a></p></div>'),
    ck_index(CK_URL).replace(b'<li>', b'<li><br/>'),
]
CK_ARTICLES = [
    ck_detail(), *[ck_detail(salary=s) for s in ('時薪$500', '單次$3,000 ~ $5,000', '單次$3,000～5,000', '單次$5000/次', '單次$5000元', '單次$0', '單次$5000 ~ $3000',
                                                 '單次$,,,', '時薪$200', '面議', '', '單次$５０００', '單次$5000 ~', '單次$1,000~$2,000/次')],
    ck_detail(url=CK_URL.replace('Ab', 'Ac')), ck_detail(body=''), ck_detail(og=''), ck_detail(og='<meta property="og:url">'),
    ck_detail(og='<meta property="og:url" content="/job-Ab1234567890">'), ck_detail(prefix='內容'), ck_detail(title=''), ck_detail(title='x' * 501),
    ck_detail(extra='<section class="job-address">台北市 <style>.x{}</style>信義區</section>'),
    ck_detail(body='a<script>bad()</script>b<br/>c'), ck_detail(extra='<div class>bare</div>'), ck_detail(extra='<p class="job_salary_address-block">另計</p>'),
    ck_detail(body='<section class="job-content">nested</section>'), ck_detail(extra='<section class="JOB-ADDRESS">x</section>'),
    ck_detail(extra='<section class="x\tjob-address">台中</section>'), b'<title>Just a moment</title>' + ck_detail(), b'<h1>Missing</h1>',
    ck_detail() + b'\xff', ck_detail(body='x' * 100_001),
]


def ck_index_case(raw):
    def run():
        urls, total = chickpt.parse_index(raw)
        return dict(urls=urls, total=total)
    return dict(input=raw.decode('latin-1'), expect=attempt(run))


def page_fetch_case(module, pages, **kw):
    def run():
        patches = [patch.object(module, 'build_opener', lambda *a: UrllibOpener(pages)), patch.object(module, 'read_body', limited_body),
                   patch.object(module.time, 'sleep', lambda s: None)]
        if hasattr(module, 'datetime'):
            patches.append(patch.object(module, 'datetime', FixedNow))
        for p in patches:
            p.start()
        try:
            return encode(module.fetch(**kw))
        finally:
            for p in patches:
                p.stop()
    return dict(pages=wire(pages), expect=attempt(run))


def nd_pages():
    old = 'Mon, 01 Jun 2026 00:00:00 GMT'
    feed = nd_feed(nd_item(), nd_item(link='https://nodesk.co/remote-jobs/bb/'), nd_item(link='https://nodesk.co/remote-jobs/cc/'),
                   nd_item(link='https://nodesk.co/remote-jobs/old/', date=old), nd_item(link='https://nodesk.co/remote-jobs/dd/'),
                   nd_item(link='https://nodesk.co/remote-jobs/ee/'), nd_item(link='https://nodesk.co/remote-jobs/future/', date='Sat, 03 Oct 2026 00:00:00 GMT'),
                   nd_item(link='https://evil.example/x/')).encode()
    return {nodesk.FEED: (200, feed), ND_URL: (200, ld(nd_post())), 'https://nodesk.co/remote-jobs/bb/': (404, b''),
            'https://nodesk.co/remote-jobs/cc/': (302, b''), 'https://nodesk.co/remote-jobs/ee/': (200, ld(nd_post(employmentType='FULL_TIME')))}


def jr_pages(index=None):
    entries = [jr_entry(), jr_entry(id=2, job_type='permanent', href='remote-developer-jobs/perm'), jr_entry(id=3, category='marketing', href='remote-marketing-jobs/cc'),
               jr_entry(id=4, job_type='permanent', category='marketing', href='remote-marketing-jobs/skip'), jr_entry(id=5, href='remote-developer-jobs/missing'),
               jr_entry(id=6, href='remote-developer-jobs/gone'), jr_entry(id=7, href='https://evil.example/')]
    return {justremote.INDEX: (200, index or jr_index(jr_state(entries))), JR_URL: (200, jr_detail()),
            'https://justremote.co/remote-developer-jobs/perm': (200, jr_detail(employmentType='FULL_TIME')),
            'https://justremote.co/remote-marketing-jobs/cc': (200, jr_detail()), 'https://justremote.co/remote-developer-jobs/gone': (410, b'')}


def dj_pages(**overrides):
    urls = [DJ_URL, DJ_URL + '-two', DJ_URL + '-three', DJ_URL + '-four']
    pages = {dynamitejobs.INDEX: (200, links(*urls)), DJ_URL: (200, ld(dj_post())), DJ_URL + '-two': (404, b''),
             DJ_URL + '-three': (200, ld(dj_post(url=DJ_URL + '-three', employmentType='FULL_TIME'))), DJ_URL + '-four': (500, b'')}
    return pages | overrides


def jb_pages(**overrides):
    two = JB_URL.replace('Ab1234', 'Ab1235')
    pages = {jobbank518.INDEX: (200, jb_index(JB_URL, two, JB_URL.replace('Ab1234', 'Ab1236'))), JB_URL: (200, jb_detail()), two: (200, b'<h1>Removed</h1>')}
    return pages | overrides


def ck_pages(**overrides):
    two = CK_URL.replace('Ab', 'Ac')
    pages = {chickpt.INDEX: (200, ck_index(CK_URL, two, total=3)), CK_URL: (200, ck_detail()), two: (200, ck_detail(salary='單次$0', url=two))}
    return pages | overrides


NO_PAUSE = {'pause': lambda _: None}
PAGE_FETCH = [
    (nodesk, nd_pages(), {}), (nodesk, nd_pages() | {nodesk.FEED: (403, b'')}, {}), (nodesk, nd_pages() | {nodesk.FEED: (200, b'')}, {}),
    (nodesk, nd_pages() | {nodesk.FEED: (301, b'')}, {}), (nodesk, nd_pages() | {nodesk.FEED: (204, b'')}, {}), (nodesk, {}, {}),
    (justremote, jr_pages(), {}), (justremote, jr_pages() | {justremote.INDEX: (500, b'')}, {}), (justremote, jr_pages(b'<h1>none</h1>'), {}),
    (dynamitejobs, dj_pages(), NO_PAUSE), (dynamitejobs, dj_pages(**{DJ_URL + '-two': (403, b'')}), NO_PAUSE),
    (dynamitejobs, dj_pages(**{DJ_URL + '-two': (429, b'')}), NO_PAUSE), (dynamitejobs, dj_pages(**{DJ_URL + '-two': (401, b'')}), NO_PAUSE),
    (dynamitejobs, dj_pages(**{DJ_URL + '-two': (200, b'<title>Just a moment...</title>')}), NO_PAUSE),
    (dynamitejobs, dj_pages(**{DJ_URL + '-two': (307, b'')}), NO_PAUSE), (dynamitejobs, dj_pages(**{dynamitejobs.INDEX: (403, b'')}), NO_PAUSE),
    (jobbank518, jb_pages(), NO_PAUSE), (jobbank518, jb_pages(**{jobbank518.INDEX: (200, jb_index(empty=True))}), NO_PAUSE),
    (jobbank518, jb_pages(**{JB_URL.replace('Ab1234', 'Ab1235'): (403, b'')}), NO_PAUSE),
    (jobbank518, jb_pages(**{JB_URL: (200, b'<title>Access denied</title>')}), NO_PAUSE), (jobbank518, jb_pages(**{JB_URL: (418, b'')}), NO_PAUSE),
    (chickpt, ck_pages(), NO_PAUSE), (chickpt, ck_pages(**{CK_URL: (401, b'')}), NO_PAUSE), (chickpt, ck_pages(**{CK_URL: (404, b'')}), NO_PAUSE),
    (chickpt, ck_pages(**{chickpt.INDEX: (200, ck_index())}), NO_PAUSE), (chickpt, ck_pages(**{CK_URL: (200, ck_detail(extra='<div class>x</div>'))}), NO_PAUSE),
    (chickpt, ck_pages(**{CK_URL: (200, b'\xff')}), NO_PAUSE),
]


def batch3_golden():
    return {
        'urljoin': [dict(base=b, url=u, expect=attempt(lambda: urljoin(b, u))) for b in URLJOIN_BASES for u in URLJOIN_REFS],
        'canonical_b3': [dict(source=m.__name__.rsplit('.', 1)[1], input=tag(v), expect=attempt(lambda: m.canonical(v)))
                         for m in (nodesk, justremote, dynamitejobs, jobbank518, chickpt)
                         for v in URLJOIN_REFS + [None, 5, ND_URL, JR_URL, DJ_URL, JB_URL, CK_URL, ND_URL + '?a=1#b', JR_URL + '#x', DJ_URL + '?u=1',
                                                  JB_URL.upper(), CK_URL + '/', '/job-Ab1234.html', '/job-Ab1234567890', '/company/a/remote-job/b']],
        'py_upper': [dict(input=s, expect=s.upper()) for s in UPPER],
        'raw_decode': [dict(input=s, expect=attempt(lambda: (lambda r: [encode(r[0]), r[1]])(json.JSONDecoder().raw_decode(s)))) for s in RAW_DECODE],
        'date_iso': [dict(input=s, expect=attempt(lambda: _date.fromisoformat(s).isoformat())) for s in DATE_ISO],
        'b3_re': [dict(pattern=p, ignorecase=bool(f & re.I), dotall=bool(f & re.S), mode=mode, input=s,
                       expect=(lambda m: None if m is None else dict(span=list(m.span()), groups=list(m.groups())))(getattr(re, mode)(p, s, f)))
                  for p, f, mode in B3_RES for s in B3_RE_TEXT],
        'nodesk_feed': [nd_feed_case(d.encode()) for d in ND_FEEDS] + [nd_feed_case(b) for b in ND_FEED_BYTES],
        'nodesk_article': [dict(input=raw.decode('latin-1'), entry=e, expect=classify(lambda: nodesk.parse_article(raw, e), (ValueError, OSError, TimeoutError)))
                           for e in ND_ARTICLE_ENTRIES for raw in (ND_ARTICLES if e is ND_ENTRY else ND_ARTICLES[:2])],
        'justremote_index': [jr_index_case(raw) for raw in JR_INDEXES],
        'justremote_article': [dict(input=raw.decode('latin-1'), entry=tag(jr_article_entry(e)),
                                    expect=classify(lambda: justremote.parse_article(raw, jr_article_entry(e)), (ValueError, TypeError, KeyError, OSError)))
                               for raw, e in JR_ARTICLES],
        'dynamitejobs_index': [dj_index_case(raw) for raw in DJ_INDEXES],
        'dynamitejobs_article': [dict(input=raw.decode('latin-1'), url=u, expect=classify(lambda: dynamitejobs.parse_article(raw, u),
                                      (ValueError, TypeError, KeyError, OSError), dynamitejobs.AccessBlocked))
                                 for u in (DJ_URL, DJ_URL + '?x=1', 'https://evil.example/') for raw in (DJ_ARTICLES if u == DJ_URL else DJ_ARTICLES[:1])],
        'jobbank518_index': [jb_index_case(raw) for raw in JB_INDEXES],
        'jobbank518_article': [dict(input=raw.decode('latin-1'), expect=classify(lambda: jobbank518.parse_article(raw, JB_URL),
                                    (ValueError, TypeError, KeyError, OSError), jobbank518.AccessBlocked)) for raw in JB_ARTICLES],
        'jobbank518_date': [dict(input=tag(v), expect=attempt(lambda: jobbank518.date_value(v))) for v in DATE_ISO + [None, 5, '2026-09-26T00:00:00Z', 'Sat, 26 Sep 2026 00:00:00 GMT']],
        'chickpt_index': [ck_index_case(raw) for raw in CK_INDEXES],
        'chickpt_article': [dict(input=raw.decode('latin-1'), expect=classify(lambda: chickpt.parse_article(raw, CK_URL, observed_at=NOW),
                                 (ValueError, TypeError, OSError), chickpt.AccessBlocked)) for raw in CK_ARTICLES],
        'page_fetch': [dict(source=m.__name__.rsplit('.', 1)[1], **page_fetch_case(m, pages, **kw)) for m, pages, kw in PAGE_FETCH],
    }


# ---------------------------------------------------------------- step 8, batch 4: taiwanjobs, arbeitnow, freelancer
from freelance.modules.collection import taiwanjobs, arbeitnow, freelancer   # noqa: E402
from urllib.parse import urlencode                                     # noqa: E402

RSTRIP = [' a ', 'a\n', 'a\x1c', 'a\x85', 'a　', '', '   ', 'a​', 'a\xa0', '\ta\t']

TJ_LABELS = taiwanjobs.LABELS
TJ_URL = 'https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=12&HIRE_ID=34'


def tj_row(**changes):
    """backend/tests/collection/test_taiwanjobs.py:row"""
    return dict(OCCU_DESC='AI agent 後端 API 工程師', WK_TYPE='兼職', JOB_DETAIL='遠端開發 AI agent 與後端 API', URL_QUERY=TJ_URL,
                TRANDATE='20260918', STOP_DATE='20261231', WKTIME='日班', SALARYCD='時薪', NT_L='500', NT_U='1000') | changes


def tj_xml(*rows, head='<?xml version="1.0"?>'):
    """backend/tests/collection/test_taiwanjobs.py:xml"""
    return (head + '<DataList>' + ''.join('<Data>' + ''.join(f'<{k}（{TJ_LABELS[k]}）><![CDATA[{v}]]></{k}（{TJ_LABELS[k]}）>' for k, v in r.items()) + '</Data>'
                                         for r in rows) + '</DataList>').encode()


def tj_url(query, path='/Internet/jobwanted/JobDetail.aspx', host='job.taiwanjobs.gov.tw', scheme='https'):
    return tj_row(URL_QUERY=f'{scheme}://{host}{path}?{query}')


TJ_DATES = ['20260918', '20261301', '20260230', '20240229', '20230229', '00000101', '00010101', '99991231', '２０２６０９１８', '2026091',
            '202609180', '2026-9-1', '20261131', '20261010', '20260001', '20260100', '١٢٣٤٠١٠١', '𝟐𝟎𝟐𝟔𝟎𝟗𝟏𝟖', '2026 918', ' 20260918',
            '20260918\n', '20261231', '20260101', '20261110', '19700101', '', 'abcdefgh', '2026091８']
TJ_BATCHES = [
    tj_xml(tj_row()), tj_xml(tj_row(JOB_DETAIL='開發 API <WKTIME（工作時間）>例子</WKTIME（工作時間）> & RAG')),
    tj_xml(tj_row(WK_TYPE='全職'), tj_row(WK_TYPE='未知', URL_QUERY=TJ_URL.replace('34', '35'))),
    b'<!DOCTYPE x [<!ENTITY p "bad">]><DataList/>', b'<html>challenge</html>', tj_xml(tj_row()).replace('（職務名稱）'.encode(), '（UNKNOWN）'.encode()),
    tj_xml(tj_row()).replace(b'</Data>', b'<WK_TYPE>x</WK_TYPE></Data>'),
    tj_xml(tj_row(URL_QUERY=TJ_URL.replace('job.taiwanjobs.gov.tw', 'evil.invalid'))), tj_xml(tj_row(TRANDATE='20269999')),
    tj_xml(tj_row(URL_QUERY=TJ_URL + '&HIRE_ID=56')), tj_xml(tj_row(), tj_row()), tj_xml(tj_row(TRANDATE='20200101')),
    tj_xml(tj_row(STOP_DATE='20260901')), tj_xml(tj_row(STOP_DATE='')), tj_xml(tj_row(STOP_DATE='20261340')), tj_xml(tj_row(STOP_DATE='abc')),
    tj_xml(tj_row(STOP_DATE='２０２６１２３１')), tj_xml(), tj_xml(tj_row(), tj_row(OCCU_DESC='', URL_QUERY=TJ_URL.replace('34', '35'))),
    tj_xml(tj_row(JOB_DETAIL='')), tj_xml(tj_row(OCCU_DESC='x' * 501)), tj_xml(tj_row(OCCU_DESC='x' * 500)),
    tj_xml(tj_url('EMPLOYER_ID=12&HIRE_ID=34', path='/Internet/index/JobDetail.aspx')),
    tj_xml(tj_url('EMPLOYER_ID=12&HIRE_ID=34', path='/internet/JOBWANTED/jobdetail.aspx')),
    tj_xml(tj_url('EMPLOYER_ID=12&HIRE_ID=34', path='/Internet/other.aspx')), tj_xml(tj_url('EMPLOYER_ID=12&HIRE_ID=34', scheme='http')),
    tj_xml(tj_url('EMPLOYER_ID=12&HIRE_ID=34', host='job.taiwanjobs.gov.tw:443')),
    tj_xml(tj_url('HIRE_ID=34&x=1&EMPLOYER_ID=12#frag')), tj_xml(tj_url('EMPLOYER_ID=0&HIRE_ID=34')), tj_xml(tj_url('EMPLOYER_ID=012&HIRE_ID=34')),
    tj_xml(tj_url('EMPLOYER_ID=1' + '2' * 20 + '&HIRE_ID=34')), tj_xml(tj_url('EMPLOYER_ID=1' + '2' * 19 + '&HIRE_ID=34')),
    tj_xml(tj_url('EMPLOYER_ID=١٢&HIRE_ID=34')), tj_xml(tj_url('EMPLOYER_ID=%31%32&HIRE_ID=34')), tj_xml(tj_url('EMPLOYER_ID=12+&HIRE_ID=34')),
    tj_xml(tj_url('EMPLOYER_ID=12&HIRE_ID=')), tj_xml(tj_url('EMPLOYER_ID=12&HIRE_ID=34&HIRE_ID=')), tj_xml(tj_url('EMPLOYER_ID=12&HIRE_ID=34&HIRE_ID')), tj_xml(tj_url('EMPLOYER_ID=12&HIRE_ID')), tj_xml(tj_url('EMPLOYER_ID=12')),
    tj_xml(tj_row(URL_QUERY='')), tj_xml(tj_row(URL_QUERY='https://[::1/x')), tj_xml(tj_row(TRANDATE='20260929')), tj_xml(tj_row(TRANDATE='20260930')),
    tj_xml(tj_row(TRANDATE='')), tj_xml(tj_row(TRANDATE='２０２６０９１８')),
    *[tj_xml(tj_row(WK_TYPE=w)) for w in ('部分工時', '接案', '承攬', '全職/兼職', 'part time', '', '  兼職 　', '兼 職')],
    tj_xml({k: 'x' for k in TJ_LABELS} | tj_row()), b'\xef\xbb\xbf' + tj_xml(tj_row()), tj_xml(tj_row()).decode().encode('utf-16'),
    tj_xml(tj_row()) + b'\xff', b'<!doctype x><DataList/>', b'<!ent\xc4\xb1ty x>' + tj_xml(tj_row()), b'<!ENTITY' + tj_xml(tj_row()),
    tj_xml(tj_row(), head='<?xml version="1.0" encoding="big5"?>'), tj_xml(tj_row(), head=''),
    b'<DataList>' + b'<Data/>' * 1001 + b'</DataList>', b'<DataList><Data/><Data/></DataList>', b'<DataList>x<Data/></DataList>',
    b'<DataList>  \n<Data/></DataList>', b'<DataList><Data a="1"/></DataList>', b'<DataList><Row/></DataList>', b'<Other/>',
    b'<DataList><Data><OCCU_DESC a="1">x</OCCU_DESC></Data></DataList>', b'<DataList><Data><OCCU_DESC><b/></OCCU_DESC></Data></DataList>',
    b'<DataList><Data><FOO>x</FOO></Data></DataList>', b'<DataList><Data><constructor>x</constructor></Data></DataList>',
    tj_xml(tj_row()).replace(b'<![CDATA[\xe6\x97\xa5\xe7\x8f\xad]]>', b'\xe6\x97\xa5<!-- c -->\xe7\x8f\xad'),
    tj_xml(tj_row()).replace(b'<![CDATA[\xe6\x97\xa5\xe7\x8f\xad]]>', b'a&amp;b&lt;c'), b'<DataList><Data></Data>', b'', b'x',
    '<DataList><Data><OCCU_DESC（職務名稱）>AI agent</OCCU_DESC（職務名稱）><URL_QUERY（職缺資料URL）>{}</URL_QUERY（職缺資料URL）><TRANDATE>20260918</TRANDATE></Data></DataList>'.format(TJ_URL.replace('&', '&amp;')).encode(),
    tj_xml(tj_row()).replace(b'<Data>', b'<Data>\n  ', 1), tj_xml(tj_row()).replace(b'</DataList>', b'</DataList>tail'),
    '<DataList><ns:Data xmlns:ns="u"/></DataList>'.encode(), tj_xml(tj_row(JOB_DETAIL=']]><x>')),
]


def tj_batch_case(raw):
    return dict(input=raw.decode('latin-1'), expect=attempt(lambda: encode(taiwanjobs.parse_batch(raw, now=NOW))))


AN_STAMP = 1790000000


def an_entry(**changes):
    """backend/tests/collection/test_arbeitnow.py:entry, with a fixed created_at"""
    return dict(slug='ai-agent-123', title='Part time AI agent developer', description='<p>Build an AI agent and API.</p>', remote=True,
                url='https://www.arbeitnow.com/jobs/companies/acme/ai-agent-123', tags=['AI'], job_types=['Part Time'], location='Remote',
                created_at=AN_STAMP) | changes


def an_payload(*entries, page=1, nxt=None, **meta):
    """backend/tests/collection/test_arbeitnow.py:payload"""
    return json.dumps(dict(data=list(entries), meta={'current_page': page, 'per_page': 250, 'from': 1 if entries else None,
                                                     'to': len(entries) or None} | meta, links={'next': nxt})).encode()


AN_BASE_DESC = '<p>Build an AI agent and API.</p>'
AN_ENTRIES = [
    an_entry(), an_entry(url='https://www.arbeitnow.ch/jobs/companies/acme/ai-agent-123'), an_entry(url='https://www.arbeitnow.ch.evil.test/jobs/companies/acme/ai-agent-123'),
    an_entry(url='https://www.arbeitnow.co.uk/jobs/companies/acme/ai-agent-123/'), an_entry(url='https://www.arbeitnow.fr/jobs/companies/acme/ai-agent-123?utm=x#y'),
    an_entry(url='http://www.arbeitnow.com/jobs/companies/acme/ai-agent-123'), an_entry(url='https://www.arbeitnow.com/jobs/acme/ai-agent-123'),
    an_entry(url='https://www.arbeitnow.com/jobs/companies/acme/other'), an_entry(url='https://www.arbeitnow.com/jobs/companies/acme/ai-agent-123//'),
    an_entry(url=None), an_entry(url=5), an_entry(url='https://WWW.arbeitnow.com/jobs/companies/acme/ai-agent-123'),
    an_entry(slug='bad slug'), an_entry(slug='x' * 201), an_entry(slug=None), an_entry(slug='ai-agent-123\n'),
    *[an_entry(created_at=v) for v in (0, -1, True, 1790000000.0, 10 ** 20, 2 ** 63, 2 ** 62, 253402300800, 253402300799, '1790000000', None)],
    *[an_entry(job_types=v) for v in ('Part Time', [1], [], ['Full-Time'], [' Part-time '], ['freelance', 'contract'], ['Fulltime', 'Part Time'],
                                      ['PART TIME'], ['full time'], ['Part Time'], ['part-time'], ['internship'], ['Contract ', 'İ'])],
    an_entry(location=None), an_entry(location=5), an_entry(remote='yes'), an_entry(remote=False), an_entry(title=None), an_entry(title=''),
    an_entry(title='x' * 501), an_entry(description=None), an_entry(description=''),
    *[an_entry(description=AN_BASE_DESC + sep + f) for f in arbeitnow.PROMOTIONAL_FOOTERS for sep in ('\n', '', '  ')],
    an_entry(description=AN_BASE_DESC + arbeitnow.PROMOTIONAL_FOOTERS[0] + '　\n'), an_entry(description=AN_BASE_DESC + arbeitnow.PROMOTIONAL_FOOTERS[0] + '<p>Must live in Germany</p>'),
    *[an_entry(description=AN_BASE_DESC + arbeitnow.PROMOTIONAL_FOOTERS[0] + ws) for ws in ('\x85', '\x1c', '\x1f', '\ufeff', '\u2028', '\x0b')],
    an_entry(description=AN_BASE_DESC + '<p>Find Jobs in Germany on Arbeitnow</p>'), an_entry(description=arbeitnow.PROMOTIONAL_FOOTERS[1]),
    an_entry(description=AN_BASE_DESC + arbeitnow.PROMOTIONAL_FOOTERS[1] + arbeitnow.PROMOTIONAL_FOOTERS[0]),
    [], None, 'x', an_entry(tags=None) | {'extra': [1]},
]


def an_normalize_case(e):
    return dict(entry=tag(e), expect=attempt(lambda: encode(arbeitnow.normalize(e))))


def an_raw(payload, **changes):
    raw = json.loads(payload)
    for k, v in changes.items():
        raw[k] = v
    return json.dumps(raw).encode()


AN_NEXT = 'https://www.arbeitnow.com/api/job-board-api?page=2'
AN_BATCHES = [
    (an_payload(an_entry()), 1), (an_payload(an_entry()), 2), (an_payload(an_entry(), page=2), 2), (an_payload(), 1), (b'{}', 1), (b'', 1), (b'x', 1),
    (b'[]', 1), (an_raw(an_payload(), data={}), 1), (an_raw(an_payload(), meta=None), 1), (an_payload(page=True), 1), (an_payload(page=1.0), 1),
    (an_raw(an_payload(an_entry()), links=None), 1), (an_raw(an_payload(an_entry()), links={}), 1),
    *[(an_payload(an_entry(), nxt=link), 1) for link in (AN_NEXT, 'https://www.arbeitnow.nl/api/job-board-api?page=2', 'https://evil.test/api/job-board-api?page=2',
                                                         'https://www.arbeitnow.nl.evil.test/api/job-board-api?page=2', 'https://www.arbeitnow.nl/api/job-board-api?page=2&token=x',
                                                         'http://www.arbeitnow.com/api/job-board-api?page=2', 'https://www.arbeitnow.com/api/job-board-api?page=1',
                                                         'https://www.arbeitnow.com/api/job-board-api?page=2&token=x', AN_NEXT + '#x', AN_NEXT + '#',
                                                         'https://www.arbeitnow.com/api/job-board-api/?page=2', 'https://www.arbeitnow.com/api/job-board-api?page=02',
                                                         'https://www.arbeitnow.com/api/job-board-api?page=%32', ' ' + AN_NEXT, AN_NEXT + '\n', 5, '')],
    (an_payload(nxt=AN_NEXT), 1), (an_payload(an_entry(), an_entry(slug='bad', url='https://evil.example/jobs/bad')), 1),
    (an_raw(an_payload(), data=[{}] * (arbeitnow.MAX_PAGE_ENTRIES + 1)), 1), (an_raw(an_payload(), data=[{}] * 3), 1),
    (an_payload(an_entry(created_at=10 ** 20)), 1), (an_payload(an_entry(created_at=2 ** 63)), 1),
    (json.dumps({'data': [an_entry()], 'meta': {'current_page': 1}, 'links': {'next': None}}).encode('utf-16'), 1),
]


def an_batch_case(raw, page):
    def run():
        jobs, rejected, nxt = arbeitnow.parse_batch(raw, page=page)
        return dict(jobs=[encode(j) for j in jobs], rejected=rejected, next=nxt)
    return dict(input=raw.decode('latin-1'), page=page, expect=attempt(run))


def an_page(page, entries, nxt, **meta):
    return an_payload(*entries, page=page, nxt=nxt, **meta)


AN_E1, AN_E2 = an_entry(slug='job-1', url='https://www.arbeitnow.com/jobs/companies/acme/job-1'), an_entry(slug='job-2', url='https://www.arbeitnow.com/jobs/companies/acme/job-2')
AN_P2 = arbeitnow.ENDPOINT + '?page=2'
AN_SCANS = [
    ({arbeitnow.ENDPOINT: (200, an_payload(an_entry()))}, {}, None),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [AN_E1], AN_NEXT, per_page=1, **{'from': 1, 'to': 1})), AN_P2: (200, an_page(2, [AN_E2], None, per_page=1, **{'from': 2, 'to': 2}))}, {}, None),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [AN_E1], AN_NEXT)), AN_P2: (200, an_page(2, [AN_E1, AN_E2], None))}, {}, None),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [an_entry(description='<p>20 hours</p>')], AN_NEXT)), AN_P2: (200, an_page(2, [an_entry(description='<p>40 hours</p>')], None))}, {}, None),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [an_entry()], AN_NEXT))}, {'max_pages': 1}, None),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [an_entry()], AN_NEXT))}, {}, [0, 1, 121]),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [an_entry()], AN_NEXT))}, {}, [0, 1, 119]),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [an_entry()], AN_NEXT)), AN_P2: (200, an_page(2, [AN_E2], None))}, {}, [0, 1, 116, 121]),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [an_entry()], AN_NEXT)), AN_P2: (200, an_page(2, [AN_E2], None))}, {}, [0, 1, 116, 119.5, 120]),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [an_entry()], AN_NEXT)), AN_P2: (404, b'')}, {}, None),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [an_entry()], AN_NEXT))}, {}, None),
    ({arbeitnow.ENDPOINT: (301, b'')}, {}, None), ({arbeitnow.ENDPOINT: (204, b'')}, {}, None), ({arbeitnow.ENDPOINT: (500, b'')}, {}, None),
    *[({arbeitnow.ENDPOINT: (200, an_page(1, [an_entry()], None, **meta))}, {}, None)
      for meta in ({'per_page': 100, 'from': 101, 'to': 250}, {'per_page': True}, {'from': None}, {'to': 2}, {'per_page': 0}, {'per_page': 10001},
                   {'per_page': 1.0}, {'from': 1.0}, {'per_page': 1}, {'from': True, 'to': True})],
    ({arbeitnow.ENDPOINT: (200, an_page(1, [AN_E1], AN_NEXT, per_page=2, **{'from': 1, 'to': 1})), AN_P2: (200, an_page(2, [AN_E2], None, per_page=2, **{'from': 3, 'to': 3}))}, {}, None),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [AN_E1], AN_NEXT, per_page=1, **{'from': 1, 'to': 1})), AN_P2: (200, an_page(2, [AN_E2], None, per_page=2, **{'from': 3, 'to': 3}))}, {}, None),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [AN_E1], AN_NEXT, per_page=True)), AN_P2: (200, an_page(2, [AN_E2], None, per_page=1, **{'from': 2, 'to': 2}))}, {}, None),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [], None, per_page=250))}, {}, None),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [an_entry(), an_entry(slug='bad', url='https://evil.example/jobs/bad')], None))}, {}, None),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [an_entry()], AN_NEXT))}, {'max_pages': 0}, None), ({arbeitnow.ENDPOINT: (200, an_page(1, [an_entry()], None))}, {'max_seconds': 0}, None),
    ({arbeitnow.ENDPOINT: (200, an_page(1, [an_entry()], None))}, {'max_seconds': 301}, None),
]


def an_scan_case(pages, kw, ticks):
    calls = []

    def reader(url, timeout):
        calls.append([url, timeout])
        with patch.object(arbeitnow, 'build_opener', lambda *a: UrllibOpener(pages)):
            return arbeitnow.fetch(url, timeout=timeout)

    def run():
        mono = (lambda it: (lambda: next(it)))(iter(ticks)) if ticks else (lambda: 0)
        with patch.object(arbeitnow.time, 'sleep', lambda s: None):
            jobs, coverage = arbeitnow.scan(reader=reader, monotonic=mono, **kw)
        return encode([jobs, coverage])
    expect = attempt(run)
    return dict(pages=wire(pages), kw=kw, ticks=ticks, expect=expect, calls=calls)


def fl_project(**extra):
    """backend/tests/collection/test_freelancer.py:project"""
    return dict(id=42, title='AI agent backend', description='Build an API', status='active', type='fixed', budget={'minimum': 100, 'maximum': 500},
                currency={'code': 'USD'}, time_updated=1789742168, language='en', seo_url='python/AI-agent', deleted=False, nonpublic=False) | extra


FL_PROJECTS = [
    fl_project(), *[fl_project(**p) for p in ({'description': None}, {'time_updated': None}, {'budget': {'maximum': float('nan')}}, {'nonpublic': True},
                                             {'status': 'closed'}, {'seo_url': '//evil.com'})],
    *[fl_project(id=v) for v in (0, -1, True, '42', 42.0, 10 ** 30)], fl_project(deleted=1), fl_project(deleted=''), fl_project(nonpublic=[]), fl_project(nonpublic=[0]),
    fl_project(title=''), fl_project(title='x' * 501), fl_project(title='x' * 500), fl_project(description='x' * 50001), fl_project(description=''),
    *[fl_project(time_updated=v) for v in (1789742168.5, 1789742168.0, 0, -1, float('inf'), 1e20, 10 ** 20, 10 ** 400, True, '1789742168', 2 ** 63, 253402300799, 253402300800, 1e-7)],
    fl_project(currency={'code': 'usd'}), fl_project(currency=None), fl_project(currency='USD'), fl_project(currency={'code': 'USDX'}), fl_project(currency={}),
    fl_project(currency={'code': 'ＵＳＤ'}), fl_project(currency={'code': 'USD\n'}),
    *[fl_project(budget=b) for b in (None, {}, {'minimum': None}, {'minimum': -1}, {'minimum': 500, 'maximum': 100}, {'minimum': 1.5, 'maximum': True},
                                     {'maximum': float('inf')}, {'minimum': 100, 'maximum': 100.0}, {'minimum': 10 ** 400}, {'minimum': '1'}, [], {'minimum': 0.5, 'maximum': 0.25},
                                     {'minimum': 2 ** 64, 'maximum': 2 ** 64 + 1}, {'minimum': 2 ** 53 + 1, 'maximum': 2.0 ** 53})],
    *[fl_project(seo_url=s) for s in ('python/AI-agent/x', 'python', 'python/', 'py thon/x', 'python/AI-agent\n', None, 'ü/x')],
    fl_project(type='contest'), fl_project(type='hourly'), fl_project(type=None), [], None, 'x', 5,
    {k: v for k, v in fl_project().items() if k != 'currency'}, {k: v for k, v in fl_project().items() if k != 'budget'},
]


def fl_url(query='AI agent', limit=20, offset=0):
    return 'https://www.freelancer.com/api/projects/0.1/projects/active/?' + urlencode({'query': query, 'limit': limit, 'offset': offset, 'full_description': 'true'})


def fl_page(ids, total, **extra):
    return json.dumps({'status': 'success', 'result': {'projects': [fl_project(id=i) if isinstance(i, int) else i for i in ids], 'total_count': total}} | extra).encode()


FL_SEARCHES = [
    ('AI agent', {fl_url(limit=5): (200, fl_page([42], 100))}, {'limit': 5, 'max_pages': 1}, None),
    ('AI agent', {fl_url(limit=2): (200, fl_page([1, 2], 3)), fl_url(limit=2, offset=2): (200, fl_page([3], 3))}, {'limit': 2}, None),
    ('AI agent', {fl_url(limit=3): (200, fl_page([1, 2], 5)), fl_url(limit=3, offset=3): (200, fl_page([3, 4, 5], 5))}, {'limit': 3}, None),
    ('AI agent', {fl_url(limit=2): (200, fl_page([1, 2], 4)), fl_url(limit=2, offset=2): (200, fl_page([2, 3], 4))}, {'limit': 2}, None),
    ('AI agent', {fl_url(limit=2): (200, fl_page([1, 2], 100)), fl_url(limit=2, offset=2): (200, fl_page([1, 2], 100))}, {'limit': 2}, None),
    ('AI agent', {fl_url(limit=2): (200, fl_page([1, 2], 100))}, {'limit': 2, 'max_pages': 1}, None),
    ('AI agent', {fl_url(limit=2): (200, fl_page([1], 100))}, {'limit': 2, 'max_pages': 1}, None),
    ('AI agent', {fl_url(limit=2): (200, fl_page([1, 2], 100))}, {'limit': 2, 'max_seconds': 1}, [0, 0, 1]),
    ('AI agent', {fl_url(limit=2): (200, fl_page([1, 2], 100)), fl_url(limit=2, offset=2): (200, fl_page([3, 4], 100))}, {'limit': 2, 'max_seconds': 10}, [0, 0, 9, 9.5]),
    ('AI agent', {fl_url(limit=2): (200, fl_page([1, 2], 100)), fl_url(limit=2, offset=2): (200, fl_page([3, 4], 100))}, {'limit': 2, 'max_seconds': 10, 'max_pages': 2}, [0, 0, 9, 9.3]),
    ('AI agent', {fl_url(limit=2): (200, fl_page([1, 2], 100)), fl_url(limit=2, offset=2): (429, b'')}, {'limit': 2}, None),
    ('AI agent', {fl_url(limit=2): (200, fl_page([1, fl_project(id=2, seo_url='malformed')], 2))}, {'limit': 2}, None),
    ('AI agent', {fl_url(): (204, b'')}, {}, None), ('AI agent', {fl_url(): (301, b'')}, {}, None), ('AI agent', {fl_url(): (200, b'x')}, {}, None),
    ('AI agent', {}, {}, None),
    ('AI agent', {fl_url(): (200, fl_page([1], 1, status='error'))}, {}, None), ('AI agent', {fl_url(): (200, json.dumps({'status': 'success', 'result': {'projects': {}, 'total_count': 1}}).encode())}, {}, None),
    ('AI agent', {fl_url(limit=1): (200, fl_page([1, 2], 2))}, {'limit': 1}, None), ('AI agent', {fl_url(): (200, fl_page([1, 2], 1))}, {}, None),
    ('AI agent', {fl_url(): (200, fl_page([1], 1.0))}, {}, None), ('AI agent', {fl_url(): (200, fl_page([1], True))}, {}, None),
    ('AI agent', {fl_url(): (200, fl_page([], 0))}, {}, None), ('AI agent', {fl_url(): (200, fl_page([], 5))}, {}, None),
    ('AI agent', {fl_url(limit=1): (200, fl_page([1], 2)), fl_url(limit=1, offset=1): (200, fl_page([fl_project(id=1, title='Changed AI agent')], 2))}, {'limit': 1}, None),
    ('AI agent', {fl_url(limit=1): (200, fl_page([1], 2)), fl_url(limit=1, offset=1): (200, fl_page([fl_project(id=1, time_updated=1789742169)], 2))}, {'limit': 1}, None),
    ('AI agent', {fl_url(limit=1): (200, fl_page([fl_project(id=1, time_updated=1789742169)], 2)), fl_url(limit=1, offset=1): (200, fl_page([1], 2))}, {'limit': 1}, None),
    ('AI agent', {fl_url(limit=1): (200, fl_page([1], 3)), fl_url(limit=1, offset=1): (200, fl_page([fl_project(id=2, seo_url='bad')], 3)),
                  fl_url(limit=1, offset=2): (200, fl_page([3], 3))}, {'limit': 1}, None),
    ('AI agent', {fl_url(): (200, fl_page([fl_project(time_updated=10 ** 20)], 1))}, {}, None),
    ('AI agent', {fl_url(limit=3): (200, fl_page([1, 5, fl_project(id=3, currency=None)], 3))}, {'limit': 3}, None),
    ('AI agent', {fl_url(limit=2): (200, fl_page([1, 2], 100)), fl_url(limit=2, offset=2): (200, fl_page([3, 4], 100))}, {'limit': 2, 'max_seconds': 10}, [0, 0, 9.5, 9.6]),
    ('MVP web development', {fl_url('MVP web development', limit=100): (200, fl_page([1], 1))}, {'limit': 100}, None),
    ('other', {}, {}, None), ('AI agent', {}, {'limit': 0}, None), ('AI agent', {}, {'limit': 101}, None), ('AI agent', {}, {'max_pages': 0}, None),
    ('AI agent', {}, {'max_seconds': 0}, None), ('AI agent', {}, {'max_seconds': 121}, None), ('AI agent', {}, {'max_seconds': float('nan')}, None),
    ('AI agent', {fl_url(): (200, fl_page([1], 1))}, {'max_seconds': 120}, None),
]


def fl_search_case(query, pages, kw, ticks):
    calls = []

    class Recorder(UrllibOpener):
        def open(self, request, timeout=None):
            calls.append([request.full_url, timeout])
            return super().open(request, timeout)

    def run():
        mono = (lambda it: (lambda: next(it)))(iter(ticks)) if ticks else (lambda: 0)
        return encode(freelancer.search(query, opener=Recorder(pages), pause=lambda s: None, monotonic=mono, **kw))
    expect = attempt(run)
    return dict(query=query, pages=wire(pages), kw=tag(kw), ticks=ticks, expect=expect, calls=calls)


B4_RES = [(freelancer.TITLE_SIGNAL.pattern, re.I), (freelancer.OUT_OF_SCOPE.pattern, re.I), ('兼職|部分工時|接案|承攬', 0)]
B4_RE_TEXT = ['AI agent backend', 'Back-end', 'backXend', 'back\nend', 'full stack', 'Full_Stack', 'web  app', 'web\napp', 'webapp', 'bots', 'chatbot',
              'ＡＩ', 'aİ', 'AI-powered', 'xai', 'ai_x', 'Website Home Page Copywriting', 'SEO', 'ſeo', 'séo', 'link\tbuilding', 'linkbuilding',
              'Lead  Generation', 'sales', 'salesforce', 'testing', 'Pen-Testing', 'VAPT', 'web scraping', 'Data Entry', 'logos', 'Graphic Design',
              'graphic designer', 'KI', 'ki', 'automation', 'Integration', 'MVP', 'mvp2', 'software  development', 'app development', '兼職',
              '部分工時', '接案', '承攬', '全職', '兼 職', '', 'AI', 'Ai', 'aI', 'Bot', 'BOT', 'ḃot', 'api', 'API_v2', 'apis']


def batch4_golden():
    return {
        'py_rstrip': [dict(input=s, expect=s.rstrip()) for s in RSTRIP],
        'b4_re': [dict(pattern=p, ignorecase=bool(f & re.I), dotall=False, mode='search', input=s,
                       expect=(lambda m: None if m is None else dict(span=list(m.span()), groups=list(m.groups())))(re.search(p, s, f)))
                  for p, f in B4_RES for s in B4_RE_TEXT],
        'taiwanjobs_date': [dict(input=s, expect=attempt(lambda: taiwanjobs.date(s).isoformat())) for s in TJ_DATES],
        'taiwanjobs_batch': [tj_batch_case(raw) for raw in TJ_BATCHES],
        'taiwanjobs_strict': [tj_batch_case(raw) | dict(expect=attempt(lambda: encode(taiwanjobs.parse(raw, now=NOW)))) for raw in TJ_BATCHES[:12]],
        'arbeitnow_normalize': [an_normalize_case(e) for e in AN_ENTRIES],
        'arbeitnow_batch': [an_batch_case(raw, page) for raw, page in AN_BATCHES],
        'arbeitnow_scan': [an_scan_case(pages, kw, ticks) for pages, kw, ticks in AN_SCANS],
        'freelancer_normalize': [dict(project=tag(p), expect=attempt(lambda: encode(freelancer.normalize(p)))) for p in FL_PROJECTS],
        'freelancer_search': [fl_search_case(*c) for c in FL_SEARCHES],
    }


# ---------------------------------------------------------------- step 9a: Resend Receiving, tasker and linkedin
from freelance.modules.collection import resend_preview as rp, resend_sync   # noqa: E402
from freelance.modules.collection.tasker import parse_tasker            # noqa: E402
from freelance.modules.collection.linkedin_mail import parse_linkedin   # noqa: E402
from freelance.modules.collection.mail import MailMessage               # noqa: E402
from email.utils import getaddresses                                    # noqa: E402

MAIL_MID = '4ef9a417-02e9-4d39-ad75-9611e0fcc33c'
MAIL_TARGET = 'test@inbox.resend.app'


def mail_id(n):
    return f'{n:08x}-02e9-4d39-ad75-9611e0fcc33c'


def tasker_listing(extra='', description='串接 API 與建立網站。'):
    """backend/tests/fixtures/tasker.py:listing"""
    return f'''<html><style>HIDDEN STYLE</style><script>HIDDEN SCRIPT</script>
    <img src="https://tracking.example/pixel?private=fake">
    <p>2026/09/17 最新案件，限時搶先提案！</p><h2>測試網站</h2>
    <p>$100,000</p><p>台北市</p><h3>需求說明</h3><p>{description}</p>
    <a href="https://www.tasker.com.tw/cases/Ab123?private=fake">查看完整資訊</a>
    <a href="https://www.tasker.com.tw/cases/Ab123">同案件</a>{extra}
    <p>其它需求</p><p>FOOTER MUST NOT SURVIVE</p>
    <a href="https://www.tasker.com.tw/login?private=fake">登入</a></html>'''


def received_mail(**changes):
    """backend/tests/fixtures/resend_preview.py:mail"""
    return dict(id=MAIL_MID, **{'from': 'Tasker <deals@tasker.com.tw>'}, to=['owner@gmail.com'], received_for=[MAIL_TARGET],
                created_at='2026-09-18T10:00:00Z', subject='新案件【測試網站】', html=tasker_listing(), text=None) | changes


LI_CARD = ('Freelance Backend API Engineer (Remote)\nExample Co\nSingapore\nFast growing\n'
           'View job: https://www.linkedin.com/comm/jobs/view/1234/?otpToken=private&trackingId=private')


def li_body(cards=None, header='New jobs match your preferences.', first='Your job alert for backend in Asia', extra=''):
    """backend/tests/fixtures/linkedin_mail.py:mail, as the body text"""
    return (first + '\n' + header + '\n' + extra + (cards or LI_CARD) +
            '\n---------------------------------------------------------\nSee all jobs on LinkedIn: https://www.linkedin.com/jobs/')


def li_received(**changes):
    """backend/tests/bootstrap/test_linkedin_receiving.py:received"""
    return received_mail(**{'from': 'jobalerts-noreply@linkedin.com', 'text': li_body(),
                            'html': '<html>Not used or persisted</html>', 'subject': 'Example is hiring'}) | changes


ADDRESSES = [
    'Tasker <deals@tasker.com.tw>', 'deals@tasker.com.tw', '"Tasker, Inc" <deals@tasker.com.tw>', 'deals@tasker.com.tw <other@example.org>',
    'deals@tasker.com.tw.evil.example', 'a@b, c@d', '', ' ', '<>', '<deals@tasker.com.tw>', 'Tasker (comment) <deals@tasker.com.tw>',
    '(c) deals@tasker.com.tw', 'deals@tasker.com.tw (Tasker)', 'group: a@b, c@d;', 'group:;', '"quoted\\"name" <x@y>', '"unterminated <x@y>',
    'x@[1.2.3.4]', 'x@[bad', 'x@y@z', 'x@', '@y', 'x', 'x.y.z@a.b', 'x . y@a', '"a b"@c', 'x@a .b', 'x@a(c).b', 'Name <x@y> trailing',
    '((nested)) x@y', '(unbalanced x@y', 'x@y)', '\\x@y', 'x@y\\', '"x\\', 'Ｔａｓｋｅｒ <deals@tasker.com.tw>', '　deals@tasker.com.tw',
    'deals@TASKER.com.tw', 'DEALS@tasker.com.tw', 'İ@x', 'ß@x', 'ﬀ@x', 'Name <x@y>, Other <z@w>', '"a,b" <x@y>', 'a\tb <x@y>', '<x@y', 'x@y>',
    '<<x@y>>', '<@route:x@y>', '<@a,@b:x@y>', ':', ';', ',', '.', '..', '"', '()', 'x@y.', 'x@.y', '. x@y', 'x　@y', 'x@y ', 'x y@z',
    'a@b,', ',a@b', 'jobalerts-noreply@linkedin.com', 'LinkedIn <jobalerts-noreply@linkedin.com>', 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
    '"LinkedIn" <JobAlerts-NoReply@LinkedIn.com>', 'x@y; z@w', 'a b c', 'a (b) c', 'x@😀.com', '😀 <x@y>', 'x@y\r', 'x@y\n', 'a\r\n b <x@y>',
    '"a\\\\" <x@y>', '"a\\" <x@y>', 'a"b"c <x@y>', '"" <x@y>', '"(" <x@y>', '(a"b) x@y', 'x@y (a,b)', 'x@y, (c)', '　', 'x　y <z@w>',
    'Tasker <deals@tasker.com.tw', 'Tasker deals@tasker.com.tw', '<deals@tasker.com.tw> Tasker', 'x@[1.2.3.4]>', '"x@y" <deals@tasker.com.tw>',
    '<deals@tasker.com.tw>, ', 'deals@tasker.com.tw,deals@tasker.com.tw', 'g: deals@tasker.com.tw;', 'g: deals@tasker.com.tw',
]
RESEND_IDS = [MAIL_MID, MAIL_MID.upper(), '{' + MAIL_MID + '}', 'urn:uuid:' + MAIL_MID, MAIL_MID.replace('-', ''), '../not-an-id', '', None, 5,
              MAIL_MID + '\n', ' ' + MAIL_MID, MAIL_MID.replace('4', '４'), MAIL_MID.replace('-', '_'), '00000000-0000-0000-0000-000000000000',
              mail_id(1), MAIL_MID[:-1] + 'g', MAIL_MID + '0', [MAIL_MID], True,
              *[h for x in [MAIL_MID.replace('-', '')] for h in ('0x' + x[2:], '0X_' + x[3:], x[:31] + '_', 'a_' + x[2:], 'a__' + x[3:], '+' + x[1:], '-' + x[1:],
                                                                  ' ' + x[1:], '\u3000' + x[1:], x[:-1] + '\u3000', '{{' + x + '}', 'uuid:urn:' + x, x[:16] + '٣' + x[17:])]]
SENDER_VALUES = ADDRESSES + [None, 5, True, ['deals@tasker.com.tw'], 'Tasker <deals@tasker.com.tw>\r\n', 'deals@tasker.com.tw\r']
MATCH_FROM = ['Tasker <deals@tasker.com.tw>', 'jobalerts-noreply@linkedin.com', 'LinkedIn <JobAlerts-NoReply@linkedin.com>', 'Cake <notifications@no-reply.cake.me>',
              '104 <jobbank@ms1.104.com.tw>', 'attacker@example.com', None, 'deals@tasker.com.tw, jobbank@ms1.104.com.tw']
MATCH_SUBJECTS = ['新案件【測試網站】', 'Your job alert has been created', 'YOUR JOB ALERT HAS BEEN CREATED', 'Your alert HAS BEEN CREATEd ok', 'Example is hiring',
                  '某某05/06的配對日報，符合職缺3筆', 'x' * 100 + '05/06的配對日報，符合職缺3筆', 'x' * 101 + '05/06的配對日報，符合職缺3筆', '05/06的配對日報，符合職缺3筆',
                  '某05/06的配對日報，符合職缺1000筆', '某０５/06的配對日報，符合職缺3筆', '某05/06的配對日報，符合職缺3筆\n', '某\n05/06的配對日報，符合職缺3筆',
                  'Acme 刊登了一筆新職缺', 'Acme 刊登了一筆新職缺！', '刊登了一筆新職', None, 5, '']
MATCH_ENTRIES = [{'from': f, 'subject': s} for f in MATCH_FROM for s in MATCH_SUBJECTS] + [{'from': 'deals@tasker.com.tw'}, {'subject': 'x'}, {}]


def message(body, is_html=True, subject='新案件【測試網站】', sender='deals@tasker.com.tw', mid='synthetic-message', received='2026-09-17T00:00:00+00:00'):
    return MailMessage(mid, sender, subject, body, is_html, received)


TK_PLAIN = '2026/09/17 最新案件，限時搶先提案！\n測試網站\n$100,000\n台北市\n需求說明\n串接 API\n查看完整資訊 https://www.tasker.com.tw/cases/Ab123\n其它需求\nFOOTER'
TK_DESC = '建立網站，按鈕文字為查看完整資訊，另外需要串接 API，僅限美國居民。'
TK_SHORT = '2026/09/17 最新案件，限時搶先提案！\n測試網站\n$100,000\n台北市\n需求說明\nAPI\n查看完整資訊 https://www.tasker.com.tw/cases/Ab123'
TASKER_MESSAGES = [
    message(tasker_listing()),
    message(tasker_listing(description='請串接 API https://x.example/?private=fake <a href="https://x.example/?secret=fake">需求</a>')),
    *[message(tasker_listing(), sender=s) for s in ('deals@tasker.com.tw.evil.example', 'other@tasker.com.tw')],
    *[message(tasker_listing().replace('https://www.tasker.com.tw/cases/Ab123', u)) for u in (
        'http://www.tasker.com.tw/cases/Ab123', 'https://www.tasker.com.tw.evil.example/cases/Ab123', 'https://user@www.tasker.com.tw/cases/Ab123',
        'https://www.tasker.com.tw/cases/Ab-123', 'https://www.tasker.com.tw/cases/Ab123/', 'https://WWW.tasker.com.tw/cases/Ab123',
        'https://www.tasker.com.tw/cases/Ａb123', 'https://www.tasker.com.tw:443/cases/Ab123', 'https://[::1/cases/Ab123')],
    message(tasker_listing(extra='<a href="https://www.tasker.com.tw/cases/Other123">Other</a>')),
    *[message(b) for b in ('PRIVATE BODY', tasker_listing().replace('需求說明', 'PRIVATE BODY'), tasker_listing().replace('測試網站', 'PRIVATE BODY'))],
    message(TK_PLAIN, False),
    message(tasker_listing(extra='<script><a href="https://www.tasker.com.tw/cases/Secret123">hidden</a></script>',
                           description='API //tracking.example/?private=fake mailto:user@example.org?private=fake www.example.org/?private=fake')),
    message(tasker_listing(description=TK_DESC)),
    message('2026/09/17 最新案件，限時搶先提案！\n測試網站\n$100,000\n台北市\n需求說明\n' + TK_DESC + '\n查看完整資訊 https://www.tasker.com.tw/cases/Ab123\n其它需求', False),
    message(tasker_listing().replace('>查看完整資訊</a>', '>不同連結</a>').replace('串接 API 與建立網站。', '查看完整資訊')),
    message(TK_SHORT + '\n查看完整資訊 https://www.tasker.com.tw/cases/Ab123', False),
    message(TK_SHORT.replace('查看完整資訊 https:', '查看完整資訊 unrelated https:'), False),
    message(tasker_listing().replace('最新案件，限時搶先提案！', '最新上架案件，歡迎提案')),
    message('2026/09/17 最新上架案件，歡迎提案\n測試網站\n$15,000\n台北市\n需求說明\n串接 API 與建立網站。\n查看完整資訊 https://www.tasker.com.tw/cases/Ab123', False),
    message(tasker_listing().replace('最新案件，限時搶先提案！', '未知郵件格式')),
    message(tasker_listing().replace('$100,000', '預算詳談')),
    # Edges beyond the Python tests.
    message(TK_PLAIN.replace('\n', '\r\n'), False), message(TK_PLAIN.replace('\n', '\r'), False), message(TK_PLAIN.replace('\n', ' '), False),
    message(TK_PLAIN.replace('查看完整資訊 https', '  查看完整資訊\thttps'), False), message(TK_PLAIN.replace('Ab123\n', 'Ab123  \n'), False),
    message(TK_PLAIN.replace('查看完整資訊 https', '查看完整資訊https'), False), message(TK_PLAIN.replace('Ab123\n', 'Ab123　\n'), False),
    message(TK_PLAIN, False, subject='新案件【測試網站】【另一個】'), message(TK_PLAIN, False, subject='新案件'), message(TK_PLAIN, False, subject='【 】'),
    message(TK_PLAIN, False, subject='新案件【測試  網站】'), message(TK_PLAIN.replace('測試網站', '測試 網站'), False, subject='新案件【測試  網站】'),
    message(TK_PLAIN.replace('測試網站', 'a.b (c)+[d]$'), False, subject='【a.b (c)+[d]$】'), message(TK_PLAIN.replace('測試網站', 'a.b'), False, subject='【a?b】'),
    message(TK_PLAIN.replace('測試網站', 'a\\b'), False, subject='【a\\b】'), message(TK_PLAIN.replace('測試網站', 'x{2}'), False, subject='【x{2}】'),
    message(TK_PLAIN.replace('$100,000', '$1,000,000'), False), message(TK_PLAIN.replace('$100,000', '$'), False), message(TK_PLAIN.replace('$100,000', '＄100'), False),
    message(TK_PLAIN.replace('2026/09/17', '２０２６/09/17'), False), message(TK_PLAIN.replace('串接 API', ''), False), message(TK_PLAIN.replace('串接 API', '　'), False),
    message(TK_PLAIN.replace('串接 API', 'see https://evil.example/x'), False),
    message(tasker_listing().replace('<a href="https://www.tasker.com.tw/cases/Ab123?private=fake">', '<A HREF="https://www.tasker.com.tw/cases/Ab123?private=fake">')),
    message(tasker_listing().replace('>查看完整資訊</a>', '><b>查看</b>完整資訊</a>')), message(tasker_listing().replace('>查看完整資訊</a>', '> 查看完整資訊 &gt;</a>')),
    message(tasker_listing().replace('串接 API 與建立網站。', '串接 API &amp; 建立網站&#12290;')), message(tasker_listing().replace('<p>台北市</p>', '<br/>台北市<br>')),
    message(tasker_listing().replace('<a href="https://www.tasker.com.tw/cases/Ab123?private=fake">', '<a href="https://www.tasker.com.tw/cases/Ab123?private=fake" href="https://x.example">')),
    message(tasker_listing().replace('<a href="https://www.tasker.com.tw/cases/Ab123">同案件</a>', '<a href>空</a><a href="">空</a>')),
    message(tasker_listing().replace('<script>HIDDEN SCRIPT</script>', '<noscript><p>查看完整資訊</p><a href="https://www.tasker.com.tw/cases/Zz9">x</a></noscript>')),
    message(tasker_listing().replace('<style>HIDDEN STYLE</style>', '<template><a href="https://www.tasker.com.tw/cases/Zz9">查看完整資訊</a></template>')),
    message(tasker_listing() + '<a href="https://www.tasker.com.tw/cases/Ab123">查看完整資訊'), message(tasker_listing().replace('</html>', '<a href="https://www.tasker.com.tw/cases/Ab123">查看完整資訊</a></html>')),
    message(tasker_listing().replace('<p>其它需求</p>', '<p>查看完整資訊 https://www.tasker.com.tw/cases/Ab123</p>')),
    message(tasker_listing(), subject='新案件【測試網站】 '), message(TK_PLAIN, True), message(tasker_listing(), False),
]
LI_MANAGE = 'Manage alerts: https://www.linkedin.com/comm/jobs/alerts?trackingId=private\n'
LI_TWO = ('Full-stack developer (Part-time, Equity only)\nExample Co\nIndia\nView job: https://www.linkedin.com/jobs/view/123/\n'
          '---------------------------------------------------------\nFull-time Backend Engineer\nOther Co\nRemote\nView job: https://www.linkedin.com/jobs/view/456/')
LI_DUP = 'Backend API Engineer\nExample Co\nRemote\nView job: https://www.linkedin.com/jobs/view/123/'


def li_message(body=None, **kw):
    kw = dict(sender='jobalerts-noreply@linkedin.com', subject='Example is hiring', mid='test', received='2026-09-26T02:00:00+00:00', is_html=False) | kw
    return message(li_body() if body is None else body, **kw)


LINKEDIN_MESSAGES = [
    li_message(), li_message(li_body(extra=LI_MANAGE)), li_message(li_body(extra=LI_MANAGE.replace('private', 'changed'))),
    *[li_message(li_body(extra='Manage alerts: ' + u + '\n')) for u in ('https://www.linkedin.com.evil.test/comm/jobs/alerts', 'https://www.linkedin.com/comm/jobs/view/1234/',
                                                                      'http://www.linkedin.com/comm/jobs/alerts', 'https://www.linkedin.com/comm/jobs/alerts#x',
                                                                      'https://www.linkedin.com/comm/jobs/alerts' + 'x' * 8200, 'https://[www.linkedin.com/comm/jobs/alerts')],
    li_message(li_body().replace('Example Co\n', 'Example Co\nManage alerts: https://www.linkedin.com/comm/jobs/alerts\n')),
    *[li_message(li_body(header=h)) for h in ('A new job matches your preferences.', 'Recommended content for you.', '14 new jobs match your preferences.',
                                               '2 new jobs match your preferences.', '0 new jobs match your preferences.', '14 new jobs match your preferences',
                                               'Many new jobs match your preferences.', '10000 new jobs match your preferences.', '9999 new jobs match your preferences.',
                                               '１4 new jobs match your preferences.', 'new jobs match your preferences.')],
    li_message(received='2026-09-27T02:00:00+00:00', mid='forwarded'), li_message(sender='attacker@linkedin.com'), li_message(is_html=True),
    li_message('Your job alert has been created'), li_message(li_body('Backend API Engineer\nView job: https://www.linkedin.com/jobs/view/1234/')),
    li_message(li_body(LI_TWO)), li_message(li_body(LI_DUP + '\n' + LI_DUP)), li_message(li_body(LI_DUP + '\n' + LI_DUP.replace('Example Co', 'Different Co'))),
    *[li_message(li_body(LI_DUP.replace('https://www.linkedin.com/jobs/view/123/', u))) for u in (
        'https://www.linkedin.com.evil.test/jobs/view/123/', 'https://www.linkedin.com@evil.test/jobs/view/123/', 'https://www.linkedin.com/jobs/search/?currentJobId=123',
        'http://www.linkedin.com/jobs/view/123/', 'https://www.linkedin.com/jobs/view/123', 'https://www.linkedin.com/jobs/view/' + '1' * 21 + '/',
        'https://www.linkedin.com/jobs/view/１２３/', 'https://www.linkedin.com/jobs/view/123//', 'https://www.linkedin.com/comm/jobs/view/123/?x=1#y')],
    li_message(li_body().replace('\n', '\r\n')), li_message(li_body().replace('\n', ' ')), li_message(li_body().replace('\n', '\x1c')), li_message(li_body().replace('\n', '\x85')),
    li_message(li_body().replace('\n', '\n 　 \n')), li_message(li_body().replace('Example Co', '  Example Co\t')),
    *[li_message(li_body(LI_DUP.replace('Backend API Engineer', t).replace('Remote', loc))) for t, loc in (
        ('FULL-TIME Engineer', 'Taipei'), ('Full time Engineer', 'Taipei'), ('Fulltime Engineer', 'Taipei'), ('Part time dev', 'Remote-first'),
        ('Contractor', 'Remote'), ('Contract dev', 'remotely'), ('Engineer', 'REMOTE'), ('Engineer', 'Hybrid / Remote'), ('Unpaid intern', 'X'),
        ('Equity  only', 'X'), ('EQUITY ONLY role', 'X'), ('ﬀull-time', 'X'), ('freelancer', 'X'), ('full-time_x', 'X'), ('Engineer', 'Ｒemote'),
        ('Engineer', 'Kemote'), ('x' * 501, 'Remote'), ('Has https://link', 'Remote'))],
    li_message(li_body('A\nB\nView job: https://www.linkedin.com/jobs/view/1/')), li_message(li_body('\n'.join('L%d' % i for i in range(11)) + '\nView job: https://www.linkedin.com/jobs/view/1/')),
    li_message(li_body('\n'.join('L%d' % i for i in range(10)) + '\nView job: https://www.linkedin.com/jobs/view/1/')),
    li_message(li_body(LI_DUP + '\n----------\n' + LI_DUP.replace('123', '124'))), li_message(li_body(LI_DUP + '\n---------\n' + LI_DUP.replace('123', '124'))),
    li_message(li_body(LI_DUP + '\nTrailing card line')), li_message(li_body(LI_DUP).replace('See all jobs on LinkedIn:', 'Footer')),
    li_message(li_body(first='Your job alert for ')), li_message(li_body(first='Job alert for backend')), li_message('Your job alert for x'),
    li_message(received='2026-09-26T02:00:00'), li_message(received='2026-09-26T02:00:00Z'), li_message(received='garbage'),
]


def tag_message(m):
    return dict(message_id=m.message_id, sender=m.sender, subject=m.subject, body=m.body, is_html=m.is_html, received_at=m.received_at)


class RecordingOpener:
    """The Resend transport: a fixed {url: (status, body)} map as urllib with NoRedirect serves it, recording each URL."""
    def __init__(self, pages, calls):
        self.pages, self.calls = pages, calls

    def open(self, request, timeout=None):
        self.calls.append(request.full_url)
        assert request.get_method() == 'GET' and timeout == 20
        if request.full_url not in self.pages:
            raise OSError('unknown url')
        status, body = self.pages[request.full_url]
        if not 200 <= status < 300:
            raise HTTPError(request.full_url, status, 'error', {}, None)
        return FakeResponse(status, body)


def list_url(after=None):
    return rp.ROOT + '?limit=100' + ('' if after is None else '&after=' + after)


def body_url(mid):
    return rp.ROOT + '/' + mid + '?html_format=cid'


def listing_page(entries, has_more=False, after=None, status=200):
    return {list_url(after): (status, jbytes({'data': entries, 'has_more': has_more}))}


def bodies(*mails, status=200):
    return {body_url(m['id']): (status, jbytes(m)) for m in mails}


def rn_case(source, mail, retry=False, listed=None, status=200, raw=None):
    """read_notification after one list_received, over the real ReceivingClient."""
    entry = listed if listed is not None else mail
    pages = listing_page([entry]) | {body_url(MAIL_MID): (status, raw if raw is not None else jbytes(mail))}
    calls = []
    client = rp.ReceivingClient('re_synthetic', opener=RecordingOpener(pages, calls), pause=lambda s: None, sources=(source,))

    def run():
        client.list_received()
        try:
            items = rp.read_notification(client, MAIL_MID, MAIL_TARGET, source, retry=retry)
        except rp.NotificationError as error:
            return {'stage': error.stage}
        return {'jobs': encode([item['job'] for item in items])}
    expect = attempt(run)
    return dict(source=source, retry=retry, pages=wire(pages), expect=expect, calls=calls)


LI_MAIL = li_received()
READ_NOTIFICATIONS = [
    ('tasker', received_mail()), ('tasker', received_mail(received_for=['elsewhere@example.com'])), ('tasker', received_mail(**{'from': 'attacker@example.com'})),
    ('tasker', received_mail(id='wrong')), ('tasker', received_mail(html='PRIVATE')), ('tasker', received_mail(received_for=[], to=[MAIL_TARGET])),
    ('tasker', received_mail(received_for=[MAIL_TARGET.upper()])), ('tasker', {k: v for k, v in received_mail().items() if k != 'received_for'} | {'to': [MAIL_TARGET]}),
    ('tasker', received_mail(received_for=MAIL_TARGET)), ('tasker', received_mail(received_for=[MAIL_TARGET, 5])), ('tasker', received_mail(to=None)),
    ('tasker', received_mail(created_at='2026-09-18T10:00:00')), ('tasker', received_mail(created_at='2026-09-18T18:00:00+08:00')),
    ('tasker', received_mail(created_at='2026-09-18 10:00:00.123456Z')), ('tasker', received_mail(created_at='garbage')), ('tasker', received_mail(created_at=5)),
    ('tasker', {k: v for k, v in received_mail().items() if k != 'created_at'}), ('tasker', received_mail(subject=5)),
    ('tasker', {k: v for k, v in received_mail().items() if k != 'subject'}), ('tasker', received_mail(html=None, text=TK_PLAIN)),
    ('tasker', received_mail(html='', text=TK_PLAIN)), ('tasker', received_mail(html=5)), ('tasker', received_mail(html=None, text=None)),
    ('tasker', received_mail(html=[], text=TK_PLAIN)), ('tasker', received_mail(html='\ud800')), ('tasker', received_mail(subject='新案件【其他】')),
    ('tasker', received_mail(**{'from': 'Tasker <DEALS@Tasker.com.tw>'})), ('tasker', received_mail(created_at='2026-09-18T10:00:00+00:00:30')),
    ('linkedin', LI_MAIL), ('linkedin', li_received(text=None)), ('linkedin', li_received(text='PRIVATE unsupported body')),
    ('linkedin', li_received(**{'from': 'imposter@linkedin.com'})), ('linkedin', li_received(received_for=['other@example.test'])),
    ('linkedin', li_received(subject='We‘ve turned off your job alert for software engineer in Asia', text='Administrative notice only.')),
    ('linkedin', li_received(subject="We've turned off your job alert for x", text=None)), ('linkedin', li_received(subject='New LinkedIn jobs', text='Unknown private template.')),
    ('linkedin', li_received(text=li_body().replace('Engineer (Remote)', 'Engineer (Remote, Equity only)'))), ('linkedin', li_received(html=None)),
    ('linkedin', li_received(created_at='2026-09-27T00:00:00Z')),
]
READ_EXTRA = [
    rn_case('tasker', received_mail(), retry=True), rn_case('tasker', received_mail(), listed=received_mail(**{'from': 'attacker@example.com'})),
    rn_case('tasker', received_mail(), retry=True, listed=received_mail(**{'from': 'attacker@example.com'})),
    rn_case('tasker', received_mail(), status=404), rn_case('tasker', received_mail(), raw=b'[]'), rn_case('tasker', received_mail(), raw=b'{"error": "x"}'),
    rn_case('tasker', received_mail(), raw=b'x'),
    rn_case('tasker', received_mail(), raw=json.dumps(received_mail()).encode('utf-16')),
]


def tasker_parsed(**changes):
    return parse_tasker(MailMessage('resend:' + MAIL_MID, rp.SENDER, '新案件【測試網站】', tasker_listing(), True, '2026-09-18T10:00:00+00:00'))[0] | changes


def li_parsed(**changes):
    return parse_linkedin(MailMessage('resend:' + MAIL_MID, 'jobalerts-noreply@linkedin.com', 'Example is hiring', li_body(), False, '2026-09-18T10:00:00+00:00'))[0] | changes


def ticks_from(values):
    it = iter(values)
    return lambda: next(it)


def run_mail_scenario(sc):
    with tempfile.TemporaryDirectory() as tmp:
        store = SQLiteStore(Path(tmp) / 'golden.db', clock=lambda: NOW)
        store.migrate()
        for op in sc.get('setup', []):
            kind = op['op']
            if kind == 'ingest':
                store.ingest(op['job'], op['receipt_id'])
            elif kind == 'record':
                store.record_mail(sc['source'], MAIL_TARGET, op['message_id'], op['status'], op.get('reason'))
            elif kind == 'retry':
                store.retry_mail(sc['source'], MAIL_TARGET, op['message_id'])
            elif kind == 'state':
                store.save_mail_state(sc['source'], MAIL_TARGET, op['state'])
            else:
                raise ValueError(kind)
        runs = []
        for run in sc['runs']:
            calls = []
            client = rp.ReceivingClient('re_synthetic', opener=RecordingOpener(run['pages'], calls), pause=lambda s: None, sources=(sc['source'],))
            mono = ticks_from(run['ticks']) if run.get('ticks') else (lambda: 0)
            with patch.object(resend_sync, 'monotonic', mono):
                result = attempt(lambda: encode(resend_sync._sync(client, store, run.get('recipient', MAIL_TARGET), source=sc['source'],
                                                                  max_messages=run.get('max_messages', 20), **run.get('limits', {}))))
            runs.append(dict(pages=wire(run['pages']), max_messages=run.get('max_messages', 20), limits=run.get('limits', {}),
                             ticks=run.get('ticks'), recipient=run.get('recipient', MAIL_TARGET), expect=result, calls=calls))
        with store._connect(write=False) as conn:
            tables = {}
            for table, columns, order in (
                    ('mail_sync_state', 'source,recipient,state', 'source,recipient'),
                    ('mail_ingestion', 'source,recipient,message_id,status,reason,retry_pending', 'source,recipient,message_id'),
                    ('mail_content_versions', 'opportunity_id,fingerprint,job', 'opportunity_id,fingerprint'),
                    ('opportunities', 'id,source,external_id,item', 'id'),
                    ('source_receipts', 'source,receipt_id,opportunity_id', 'source,receipt_id'),
                    ('source_health', 'source,status', 'source')):
                tables[table] = [list(row.values()) for row in conn.execute(f'SELECT {columns} FROM {table} ORDER BY {order}')]
    setup = [{k: tag(v) if k in ('job', 'state') else v for k, v in op.items()} for op in sc.get('setup', [])]
    return dict(source=sc['source'], setup=setup, runs=runs, tables=tables)


def tk(n, **changes):
    """A Tasker notification with its own message and case id."""
    return received_mail(id=mail_id(n), html=tasker_listing().replace('Ab123', 'Case%d' % n)) | changes


def pages_of(*page_entries, more_last=False, start_after=None):
    """Consecutive list pages: each page after the first continues after the previous page's last id."""
    out, after = {}, start_after
    for i, entries in enumerate(page_entries):
        last = i == len(page_entries) - 1
        out |= listing_page(entries, has_more=(more_last if last else True), after=after)
        after = entries[-1]['id'] if entries else after
    return out


OTHER = received_mail(id=mail_id(90), **{'from': 'someone@example.com'})
MAIL_SCENARIOS = {
    'tasker_import_and_replay': dict(source='tasker', runs=[dict(pages=listing_page([received_mail()]) | bodies(received_mail()))] * 2),
    'tasker_changed_existing_keeps_both_versions': dict(source='tasker', setup=[dict(op='ingest', job=tasker_parsed(description='Existing newer description'), receipt_id='original')],
                                                        runs=[dict(pages=listing_page([received_mail()]) | bodies(received_mail()))]),
    'tasker_changed_content_seen_twice': dict(source='tasker', setup=[dict(op='ingest', job=tasker_parsed(description='Existing newer description'), receipt_id='original')],
                                              runs=[dict(pages=listing_page([received_mail()]) | bodies(received_mail())),
                                                    dict(pages=listing_page([received_mail(id=mail_id(2)), received_mail()]) | bodies(received_mail(id=mail_id(2))))]),
    'tasker_same_content_other_receipt': dict(source='tasker', setup=[dict(op='ingest', job=tasker_parsed(receipt_id='gmail-original', received_at='2026-09-17T00:00:00+00:00'), receipt_id='gmail-original')],
                                              runs=[dict(pages=listing_page([received_mail()]) | bodies(received_mail()))]),
    'tasker_truncation_then_unknown': dict(source='tasker', runs=[
        dict(pages=listing_page([received_mail()], has_more=True) | bodies(received_mail()), limits={'max_pages': 1}),
        dict(pages=listing_page([received_mail(id=mail_id(0x11111111), html='PRIVATE')], after=MAIL_MID) | listing_page([received_mail(id=mail_id(0x11111111), html='PRIVATE')]) |
             bodies(received_mail(id=mail_id(0x11111111), html='PRIVATE')))]),
    'tasker_fetch_failure_then_template': dict(source='tasker', runs=[
        dict(pages=listing_page([received_mail()]) | bodies(received_mail(), status=500)),
        dict(pages=listing_page([received_mail()]) | bodies(received_mail(html='SECRET BODY')))]),
    'tasker_multi_page_and_cursor': dict(source='tasker', runs=[
        dict(pages=pages_of([tk(3), OTHER], [tk(2), tk(1)]) | bodies(tk(3), tk(2), tk(1))),
        dict(pages=listing_page([tk(5), tk(4), tk(3), OTHER]) | bodies(tk(5), tk(4))),
        dict(pages=listing_page([tk(5), tk(4)]))]),
    'tasker_body_limit_resumes_after': dict(source='tasker', runs=[
        dict(pages=listing_page([tk(3), tk(2), tk(1)]) | bodies(tk(3), tk(2), tk(1)), max_messages=2),
        dict(pages=listing_page([tk(1)], after=mail_id(2)) | bodies(tk(1)), max_messages=2),
        dict(pages=listing_page([tk(3)]), max_messages=2)]),
    'tasker_deadline_interrupts': dict(source='tasker', runs=[
        dict(pages=listing_page([tk(3), tk(2), tk(1)]) | bodies(tk(3), tk(2), tk(1)), limits={'max_seconds': 10}, ticks=[0, 1, 2, 11, 12, 13]),
        dict(pages=listing_page([tk(2), tk(1)], after=mail_id(3)) | bodies(tk(2), tk(1)), limits={'max_seconds': 10}, ticks=[0, 1, 2, 3, 4, 5, 6, 7])]),
    'tasker_fetch_failure_keeps_after': dict(source='tasker', runs=[
        dict(pages=listing_page([tk(3), tk(2), tk(1)]) | bodies(tk(3), tk(1)) | bodies(tk(2), status=503)),
        dict(pages=listing_page([tk(2), tk(1)], after=mail_id(3)) | bodies(tk(2), tk(1)))]),
    'tasker_retry_pending_recovers': dict(source='tasker', setup=[dict(op='record', message_id=MAIL_MID, status='rejected', reason='template'),
                                                                  dict(op='retry', message_id=MAIL_MID)],
                                          runs=[dict(pages=listing_page([received_mail()]) | bodies(received_mail())), dict(pages=listing_page([received_mail()]))]),
    'tasker_retry_pending_fetch_fails': dict(source='tasker', setup=[dict(op='record', message_id=MAIL_MID, status='rejected', reason='template'),
                                                                     dict(op='retry', message_id=MAIL_MID)],
                                             runs=[dict(pages=listing_page([])), dict(pages=listing_page([]) | bodies(received_mail(html='PRIVATE')))]),
    'tasker_retry_limit': dict(source='tasker', setup=[*[dict(op='record', message_id=mail_id(n), status='rejected', reason='template') for n in (7, 8, 9)],
                                                       *[dict(op='retry', message_id=mail_id(n)) for n in (9, 7, 8)]],
                               runs=[dict(pages=listing_page([tk(1)]) | bodies(tk(1), tk(7), tk(8), tk(9)), max_messages=2)]),
    'tasker_receipt_collision': dict(source='tasker', setup=[dict(op='ingest', job=tasker_parsed(external_id='third', receipt_id='x'), receipt_id='resend:' + MAIL_MID + ':Ab123')],
                                     runs=[dict(pages=listing_page([received_mail()]) | bodies(received_mail()))]),
    'tasker_reused_receipt_new_content': dict(source='tasker', setup=[dict(op='ingest', job=tasker_parsed(description='Older text'), receipt_id='resend:' + MAIL_MID + ':Ab123')],
                                              runs=[dict(pages=listing_page([received_mail()]) | bodies(received_mail()))]),
    'tasker_repeated_identity': dict(source='tasker', runs=[dict(pages=pages_of([tk(2)], [tk(2)]) | bodies(tk(2)))]),
    'tasker_list_failure': dict(source='tasker', runs=[dict(pages=listing_page([], status=500)), dict(pages={list_url(): (200, b'{"data": {}, "has_more": false}')}),
                                                       dict(pages={list_url(): (200, b'{"data": [], "has_more": 1}')})]),
    'tasker_cursor_first': dict(source='tasker', setup=[dict(op='state', state={'cursor': mail_id(5), 'after': None, 'head': None})],
                                runs=[dict(pages=listing_page([tk(5), tk(4)]))]),
    'tasker_stale_after': dict(source='tasker', setup=[dict(op='state', state={'cursor': mail_id(1), 'after': mail_id(4), 'head': mail_id(6)})],
                               runs=[dict(pages=listing_page([tk(3), tk(2), tk(1)], after=mail_id(4)) | bodies(tk(3), tk(2)))]),
    'tasker_state_missing_key': dict(source='tasker', setup=[dict(op='state', state={'cursor': None})], runs=[dict(pages=listing_page([]))]),
    'tasker_bad_limits': dict(source='tasker', runs=[dict(pages={}, recipient='owner@example.com'), dict(pages={}, recipient='X@Inbox.Resend.App'),
                                                     dict(pages={}, max_messages=0), dict(pages={}, max_messages=101), dict(pages={}, limits={'max_pages': 0}),
                                                     dict(pages={}, limits={'max_seconds': 0}), dict(pages={}, limits={'max_seconds': 301})]),
    'tasker_uppercase_recipient': dict(source='tasker', runs=[dict(pages=listing_page([received_mail()]) | bodies(received_mail()), recipient='TEST@inbox.resend.app')]),
    'tasker_already_recorded': dict(source='tasker', setup=[dict(op='record', message_id=MAIL_MID, status='processed')],
                                    runs=[dict(pages=listing_page([received_mail()]))]),
    'tasker_conflict_record_not_overwritten': dict(source='tasker', setup=[dict(op='record', message_id=MAIL_MID, status='conflict', reason='receipt_collision')],
                                                   runs=[dict(pages=listing_page([received_mail()]) | bodies(received_mail()))]),
    'linkedin_waiting_then_ok_and_replay': dict(source='linkedin', runs=[
        dict(pages=listing_page([])), dict(pages=listing_page([LI_MAIL]) | bodies(LI_MAIL)),
        dict(pages=listing_page([li_received(id=mail_id(2), created_at='2026-09-27T00:00:00Z'), LI_MAIL]) | bodies(li_received(id=mail_id(2), created_at='2026-09-27T00:00:00Z')))]),
    'linkedin_admin_notice': dict(source='linkedin', runs=[dict(pages=listing_page([li_received(subject='We‘ve turned off your job alert for software engineer in Asia', text='Administrative notice only.')]) |
                                                                bodies(li_received(subject='We‘ve turned off your job alert for software engineer in Asia', text='Administrative notice only.')))] * 2),
    'linkedin_unknown_quarantined': dict(source='linkedin', runs=[dict(pages=listing_page([li_received(subject='New LinkedIn jobs', text='Unknown private template.')]) |
                                                                       bodies(li_received(subject='New LinkedIn jobs', text='Unknown private template.')))]),
    'linkedin_unpaid_excluded': dict(source='linkedin', runs=[dict(pages=listing_page([LI_MAIL]) | bodies(li_received(text=li_body().replace('Engineer (Remote)', 'Engineer (Remote, Equity only)'))))]),
    'linkedin_excluded_but_existing_updates': dict(source='linkedin', setup=[dict(op='ingest', job=li_parsed(), receipt_id='seed')],
                                                   runs=[dict(pages=listing_page([LI_MAIL]) | bodies(li_received(text=li_body().replace('Engineer (Remote)', 'Engineer (Remote, Equity only)'))))]),
    'linkedin_created_subject_skipped': dict(source='linkedin', runs=[dict(pages=listing_page([li_received(subject='Your job alert has been created')]))]),
    'linkedin_wrong_envelope': dict(source='linkedin', runs=[dict(pages=listing_page([LI_MAIL]) | bodies(li_received(received_for=['other@example.test'])))]),
    'linkedin_truncated_repeat': dict(source='linkedin', runs=[dict(pages=listing_page([LI_MAIL], has_more=True) | listing_page([LI_MAIL], after=MAIL_MID) | bodies(LI_MAIL))]),
    'cake_and_104_waiting': dict(source='cake', runs=[dict(pages=listing_page([OTHER]))]),
    'jobbank104_waiting': dict(source='jobbank104', runs=[dict(pages=listing_page([]))]),
    'linkedin_empty_truncated': dict(source='linkedin', runs=[dict(pages=listing_page([], has_more=True))]),
}


def mail_golden():
    return {
        'getaddresses': [dict(input=a, expect=[list(t) for t in getaddresses([a])]) for a in ADDRESSES],
        'resend_id': [dict(input=tag(v), expect=attempt(lambda: rp._id(v))) for v in RESEND_IDS],
        'resend_sender': [dict(input=tag(v), expect=rp._sender(v)) for v in SENDER_VALUES],
        'resend_matches': [dict(entry=tag(e), source=s, expect=bool(rp.matches(e, s))) for e in MATCH_ENTRIES for s in ('tasker', 'linkedin', 'cake', 'jobbank104')],
        'tasker_parse': [dict(message=tag_message(m), expect=attempt(lambda: encode(parse_tasker(m)))) for m in TASKER_MESSAGES],
        'linkedin_parse': [dict(message=tag_message(m), expect=attempt(lambda: encode(parse_linkedin(m)))) for m in LINKEDIN_MESSAGES],
        'read_notification': [rn_case(s, m) for s, m in READ_NOTIFICATIONS] + READ_EXTRA,
        'mail_sync': {name: run_mail_scenario(sc) for name, sc in MAIL_SCENARIOS.items()},
    }



# ---------------------------------------------------------------- step 9b: Cake, 104, Talent.com and Glassdoor
from freelance.modules.collection import cake_mail, jobbank104_mail, talent_mail, glassdoor_mail   # noqa: E402
from urllib.parse import urlencode as _urlencode   # noqa: E402
from html.parser import HTMLParser as _HTMLParser                     # noqa: E402
import base64 as _base64                                              # noqa: E402
import zlib as _zlib                                                  # noqa: E402

class EventParser(_HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.events = []

    def handle_starttag(self, tag, attrs):
        self.events.append(['start', tag, [list(a) for a in attrs]])

    def handle_endtag(self, tag):
        self.events.append(['end', tag])

    def handle_data(self, data):
        self.events.append(['data', data])

    def handle_comment(self, data):
        self.events.append(['comment', data])


def html_events(doc, close):
    p = EventParser()
    p.feed(doc)
    if close:
        p.close()
    return p.events


HTML_EVENTS = ['<!-- Title -->x', '<!---->', '<!--->', '<!-->', '<!-- a -- b -->', '<!-- a --!>', '<!-- unterminated', '<!-- unterminated --', '<!-- unterminated -',
               '<!-- unterminated --!', '<!bogus>', '<!bogus', '</ bogus>', '</ bogus', '</>', '</', '<![CDATA[x]]>', '<![CDATA[x', '<!DOCTYPE html>', '<!doctype', '<?pi?>',
               '<a href="x"><!-- Location --><td>T</td></a>', '<p>a<!--c-->b</p>', '<!--a--><!--b-->', '<script><!-- not a comment --></script>', '<a href>x</a>',
               '<a href="1" href="2">x</a>', '<br/>', '<p>&amp; &lt;b&gt;</p>', 'text &amp', '<!-- \t Title \n -->', '<!-- <a> -->', '<!--x--!>y', '<!--x--y-->z']


def cake_tracked(value, extra=None):
    """backend/tests/collection/test_cake_mail.py:tracked"""
    raw = _urlencode(extra if extra is not None else {'d': 'example', 'l': value, 't': 'synthetic-private-token'})
    return 'https://email.no-reply.cake.me/c/' + _base64.urlsafe_b64encode(_zlib.compress(raw.encode())).decode().rstrip('=')


def cake_token(raw):
    return 'https://email.no-reply.cake.me/c/' + _base64.urlsafe_b64encode(raw).decode().rstrip('=')


CAKE_URL = 'https://www.cake.me/companies/example/jobs/backend-api'
CAKE_CANONICAL = [
    CAKE_URL, CAKE_URL + '/', CAKE_URL + '#fragment', CAKE_URL + '?x=1', 'https://cake.me/companies/example/jobs/backend-api', 'https://www.cake.me/companies/ex-ample/jobs/a_b//',
    *[cake_tracked(u) for u in (CAKE_URL + '?tracking=private', 'https://evil.test/companies/example/jobs/test', 'http://www.cake.me/companies/example/jobs/test',
                                'https://www.cake.me@evil.test/companies/example/jobs/test', 'https://www.cake.me/settings/account', CAKE_URL + '/../../settings',
                                'https://www.cake.me/companies/example/jobs/%2fsettings', CAKE_URL)],
    cake_token(_zlib.compress(b'l=' + b'A' * 100000)), 'https://email.no-reply.cake.me/c/invalid', cake_tracked(CAKE_URL) + '?redirect=other', cake_tracked(CAKE_URL) + '#x',
    cake_tracked(None, {'l': CAKE_URL, 'x': 'y'}), cake_tracked(None, {'x': 'y'}), cake_tracked(None, [('l', CAKE_URL), ('l', CAKE_URL)]), cake_tracked(None, {'l': ''}),
    cake_token(_zlib.compress(b'l=&l=' + CAKE_URL.encode())), cake_token(_zlib.compress(b'l=' + CAKE_URL.encode() + b'&l=')), cake_token(_zlib.compress(b'l=' + CAKE_URL.encode() + b'&&x=1')), cake_token(_zlib.compress(b'l=' + CAKE_URL.encode() + b'&x')),
    cake_token(_zlib.compress(b'&'.join([b'l=' + CAKE_URL.encode()] + [b'x=1'] * 19))), cake_token(_zlib.compress(b'&'.join([b'l=' + CAKE_URL.encode()] + [b'x=1'] * 20))),
    cake_token(_zlib.compress(b'l=' + CAKE_URL.encode()) + b'xx'), cake_token(_zlib.compress(b'l=' + CAKE_URL.encode())[:-2]), cake_token(b''),
    cake_token(_zlib.compress(b'l=' + CAKE_URL.encode() + b'&p=' + b'a' * (8192 - 3 - len(CAKE_URL) - 3))),
    cake_token(_zlib.compress(b'l=' + CAKE_URL.encode() + b'&p=' + b'a' * (8193 - 3 - len(CAKE_URL) - 3))),
    cake_token(_zlib.compress(b'l=' + CAKE_URL.encode() + b'&p=\xff')), cake_token(_zlib.compress(b'\xef\xbb\xbfl=' + CAKE_URL.encode())),
    cake_token(_zlib.compress('l=https://www.cake.me/companies/例/jobs/x'.encode())), cake_token(_zlib.compress(b'l=' + _urlencode({'x': CAKE_URL})[2:].encode())),
    'https://email.no-reply.cake.me/c/' + 'A' * 5, 'https://email.no-reply.cake.me/c/' + 'A' * 8193, 'https://email.no-reply.cake.me/c/a+b', 'https://email.no-reply.cake.me/c/',
    cake_tracked(CAKE_URL).replace('https://', 'http://'), 'https://www.cake.me/companies/example/jobs/', 'https://www.cake.me/companies//jobs/x', 'https://www.cake.me/companies/例/jobs/x',
    # A token one character past a whole base64 group: Python's strict decode fails, a lenient one drops it.
    next(t + 'A' for n in range(60) for t in [cake_tracked(None, {'l': CAKE_URL, 'p': 'x' * n})] if len(t.rsplit('/', 1)[1]) % 4 == 0),
    'x' * 8193, None, 5, CAKE_URL + '\n', 'https://[www.cake.me/companies/a/jobs/b', cake_token(_zlib.compress(b'l=https://[x/companies/a/jobs/b')),
]


def cake_message(body=None, **kw):
    body = body if body is not None else '<p>Personal greeting</p><a href="' + cake_tracked(CAKE_URL + '?tracking=private') + '"><span>了解詳情</span></a>'
    kw = dict(sender=cake_mail.SENDER, subject='您追蹤的 Example 刊登了一筆新職缺 - 兼職 Backend API 工程師', mid='test', received='2026-09-26T03:00:00+00:00') | kw
    return message(body, **kw)


CAKE_LINK = '<a href="' + CAKE_URL + '">了解詳情</a>'
CAKE_MESSAGES = [
    cake_message(), cake_message(CAKE_LINK, mid='another', received='2026-09-27T00:00:00+00:00'), cake_message(sender='attacker@cake.me'), cake_message(subject='New message'),
    cake_message('<a href="' + CAKE_URL + '">取消訂閱</a>'), cake_message(cake_message().body + '<a href="' + CAKE_URL + '-other">了解詳情</a>'),
    cake_message(CAKE_LINK + CAKE_LINK), cake_message(CAKE_LINK + '<a href="' + CAKE_URL + '/">了解詳情</a>'), cake_message('<a href="' + CAKE_URL + '"> 了解詳情 </a>'),
    cake_message('<a href="' + CAKE_URL + '">了解<b>詳情</b></a>'), cake_message('<a href="' + CAKE_URL + '"><a>了解詳情</a></a>'), cake_message('<a href="' + CAKE_URL + '">了解詳情'),
    cake_message('<a href>了解詳情</a>' + CAKE_LINK), cake_message('<a href><a href="x">y</a>' + CAKE_LINK), cake_message('<a>了解詳情</a>'),
    cake_message('<a href="https://evil.test/x">了解詳情</a>' + CAKE_LINK), cake_message('<a href="https://evil.test/x">其他</a>' + CAKE_LINK),
    cake_message('<a href="' + CAKE_URL + '" href="https://evil.test/x">了解詳情</a>'), cake_message('<a href="https://evil.test/x" href="' + CAKE_URL + '">了解詳情</a>'),
    cake_message('<a href="' + CAKE_URL + '">了解&#35443;情</a>'), cake_message(CAKE_LINK, is_html=False), cake_message(CAKE_LINK, received='2026-09-26'),
    *[cake_message(CAKE_LINK, subject=s) for s in ('您追蹤的 Example 刊登了一筆新職缺 - 全職 Backend', '您追蹤的 Example 刊登了一筆新職缺 - Full-time Backend', '您追蹤的 Example 刊登了一筆新職缺 - 接案 API',
                                                  '您追蹤的 Example 刊登了一筆新職缺 - freelance dev', '您追蹤的 Example 刊登了一筆新職缺 - Contractor', '您追蹤的 Example 刊登了一筆新職缺 - Backend',
                                                  '您追蹤的 A 刊登了一筆新職缺 - B 刊登了一筆新職缺 - C', '您追蹤的  刊登了一筆新職缺 - B', '您追蹤的 A 刊登了一筆新職缺 - ', '您追蹤的 A 刊登了一筆新職缺 - B\n',
                                                  '您追蹤的 A\nB 刊登了一筆新職缺 - C', '您追蹤的 ' + 'x' * 301 + ' 刊登了一筆新職缺 - B', '您追蹤的 A 刊登了一筆新職缺 - ' + 'x' * 501)],
]
JB_CARD = ('<a href="https://www.104.com.tw/job/{id}?tracking=private">兼職 Backend API 工程師</a>'
           '<a href="https://www.104.com.tw/company/company1">Example</a>'
           '<p>台北市 | 經歷不拘</p><p>API 開發需求摘要...</p><p>時薪300元以上</p>'
           '<a href="https://104app.onelink.me/zB8j/apply?private=token">我要應徵</a>')


def jb_card(ident='abc123', **repl):
    c = JB_CARD.replace('{id}', ident)
    for a, b in repl.items():
        c = c.replace(a, b)
    return c


def jb_message(body=None, **kw):
    """backend/tests/collection/test_jobbank104_mail.py:message"""
    body = body if body is not None else '<p>私人稱呼</p>' + jb_card() + '<h2>適合你大展身手的工作</h2>' + jb_card('recommend')
    kw = dict(sender=jobbank104_mail.SENDER, subject='測試09/26的配對日報，符合職缺1筆', mid='test', received='2026-09-26T03:00:00+00:00') | kw
    return message(body, **kw)


JB_TAIL = '<h2>適合你大展身手的工作</h2>'
JB_MESSAGES = [
    jb_message(), jb_message(sender='imposter@104.com.tw'), jb_message(is_html=False), jb_message(subject='驗證通知'), jb_message(received='2026-09-26'),
    jb_message(subject='測試09/26的配對日報，符合職缺2筆'), jb_message(jb_message().body.replace('適合你大展身手的工作', '新版格式')),
    jb_message(jb_message().body.replace('https://www.104.com.tw/job/', 'https://evil.test/job/')),
    jb_message(jb_message().body.replace('https://www.104.com.tw/company/', 'http://www.104.com.tw/company/')), jb_message(jb_message().body.replace('我要應徵', '未完整')),
    jb_message(jb_card() + jb_message().body, subject='測試09/26的配對日報，符合職缺2筆'), jb_message(received='2026-09-27T00:00:00Z', mid='next', body=jb_message().body.replace('tracking=private', 'tracking=other')),
    jb_message(jb_card('a1') + jb_card('b2') + JB_TAIL, subject='x09/26的配對日報，符合職缺2筆'), jb_message(jb_card('a1') + jb_card('a1') + JB_TAIL, subject='x09/26的配對日報，符合職缺2筆'),
    jb_message(jb_card(**{'<a href="https://www.104.com.tw/company/company1">Example</a>': ''}) + JB_TAIL),
    jb_message(jb_card(**{'<p>台北市 | 經歷不拘</p><p>API 開發需求摘要...</p><p>時薪300元以上</p>': ''}) + JB_TAIL),
    jb_message(jb_card(**{'<a href="https://www.104.com.tw/company/company1">Example</a>': '<a href="https://www.104.com.tw/company/c1">A</a><a href="https://www.104.com.tw/company/c2">B</a>'}) + JB_TAIL),
    jb_message(jb_card(**{'兼職 Backend API 工程師': ''}) + JB_TAIL), jb_message(jb_card(**{'兼職 Backend': '全職 Backend'}) + JB_TAIL), jb_message(jb_card(**{'兼職 Backend': 'Part-time Backend'}) + JB_TAIL),
    jb_message(jb_card(**{'兼職 Backend': '接案 Backend'}) + JB_TAIL), jb_message(jb_card(**{'兼職 Backend': 'Contract Backend'}) + JB_TAIL), jb_message(jb_card(**{'兼職 Backend': 'Backend'}) + JB_TAIL),
    jb_message(jb_card(**{'/job/abc123': '/job/ABC123'}) + JB_TAIL), jb_message(jb_card(**{'/job/abc123': '/job/abc123/'}) + JB_TAIL), jb_message(jb_card(**{'>兼職 Backend API 工程師<': '><b>兼職</b> Backend <i>API</i><'}) + JB_TAIL),
    jb_message(jb_card(**{'<p>台北市': '<p>  台北市  '}) + JB_TAIL), jb_message(jb_card(**{'<a href="https://www.104.com.tw/job/abc123?tracking=private">': '<a href="https://www.104.com.tw/job/abc123?tracking=private"><a>'}) + JB_TAIL),
    jb_message(jb_card() + JB_TAIL + '<a href="https://www.104.com.tw/job/zz9">兼職</a>'), jb_message(jb_card() + '<a href="https://[bad">x</a>' + JB_TAIL),
    jb_message(jb_card() + JB_TAIL + '<a href="https://[bad">x</a>'), jb_message('<a href>x</a>' + jb_card() + JB_TAIL), jb_message(jb_card() + JB_TAIL + '<a href="x">unclosed'),
    jb_message(jb_card(**{'我要應徵': ' 我要應徵 '}) + JB_TAIL), jb_message(jb_card() + JB_TAIL, subject='測試09/26的配對日報，符合職缺０1筆'),
    jb_message(jb_card() + JB_TAIL, subject='測試09/26的配對日報，符合職缺01筆'), jb_message(JB_TAIL, subject='測試09/26的配對日報，符合職缺0筆'),
    jb_message(jb_card() + '<p>適合你大展身手的工作</p>'), jb_message(jb_card() + '<p> 適合你大展身手的工作 </p>'), jb_message(jb_card() + '<a href="x">適合你大展身手的工作</a>'),
]
TL_CARD = '''<a href="https://tw.talent.com/redirect?id=abcdef123456">
<!-- Title --><a class="job__link" href="https://tw.talent.com/redirect?id=abcdef123456&amp;user_id=private">Backend API Engineer</a>
<!-- Location --><td>Taiwan</td><!-- Company --><td>Example</td>
<!-- Salary --><td></td><!-- Description --><td>Contractor building APIs...</td></a>'''
TL_ENGLISH = '''<!-- Job cards -->
<tr><td><a href="https://tw.talent.com/redirect?id=feedface1234&amp;user_id=private">
  <table>
    <tr><td><a href="https://tw.talent.com/redirect?id=feedface1234&amp;click_type=title">Backend API Engineer</a></td></tr>
    <tr><td>Taipei, TW</td></tr>
    <tr><td>Example Company</td></tr>
    <tr><td></td></tr>
  </table>
</a></td></tr>
<!-- View more jobs button -->'''
TL_EN_SUBJECT = "Software Engineer jobs you don't want to miss"


def tl_message(body=TL_CARD, **kw):
    """backend/tests/collection/test_talent_mail.py:setUp"""
    kw = dict(sender=talent_mail.SENDER, subject='更多职位，例如Software Engineer', mid='test', received='2026-09-26T10:17:15+00:00') | kw
    return message(body, **kw)


TALENT_CANONICAL = ['https://tw.talent.com/redirect?id=abcdef123456', 'https://tw.talent.com/redirect?id=abcdef123456&user_id=x', 'https://evil.test/redirect?id=abcdef123456',
                    'https://tw.talent.com/redirect?id=abcdef123456&id=123456abcdef', 'https://tw.talent.com/unsubscribe?id=abcdef123456', 'https://tw.talent.com/redirect?id=1',
                    'http://tw.talent.com/redirect?id=abcdef123456', 'https://tw.talent.com/redirect?id=ABCDEF123456', 'https://tw.talent.com/redirect?id=abcdef123456#x',
                    'https://tw.talent.com/redirect?id=abcdef12345%36', 'https://tw.talent.com/redirect?i%64=abcdef123456', 'https://tw.talent.com/redirect?id=&id=abcdef123456',
                    'https://tw.talent.com/redirect?' + '&'.join(['x=1'] * 29) + '&id=abcdef123456', 'https://tw.talent.com/redirect?' + '&'.join(['x=1'] * 30) + '&id=abcdef123456',
                    'https://tw.talent.com/redirect?id=abcdef123456\n', None, 'x' * 8193, 'https://[tw.talent.com/redirect?id=abcdef123456', 'https://tw.talent.com/redirect?id+=abcdef123456']
TALENT_MESSAGES = [
    tl_message(), tl_message(TL_CARD.replace('private', 'new-tracker'), mid='later', received='2026-09-27T00:00:00Z'),
    tl_message(TL_ENGLISH, subject=TL_EN_SUBJECT), tl_message(TL_ENGLISH.replace('private', 'new-tracker'), subject=TL_EN_SUBJECT),
    tl_message(TL_ENGLISH.replace('Example Company', ''), subject=TL_EN_SUBJECT),
    *[tl_message(TL_ENGLISH, subject=s) for s in ("Software Engineer - Open Source Contributions - Remote jobs you don't want to miss", "software engineer jobs you don't want to miss",
                                                 'Verify your account', "Marketing jobs you don't want to miss", "Software Engineer jobs you don't want to miss\nPrivate",
                                                 "SOFTWARE ENGINEER JOBS YOU DON'T WANT TO MISS", "Software Engineer -  jobs you don't want to miss")],
    *[tl_message(b, subject=TL_EN_SUBJECT) for b in (TL_ENGLISH.replace('<!-- Job cards -->', ''), TL_ENGLISH.replace('<!-- View more jobs button -->', ''),
                                                       TL_ENGLISH.replace('Backend API Engineer', ''), TL_ENGLISH.replace('click_type=title', 'id=bad'),
                                                       TL_ENGLISH.replace('feedface1234&amp;click_type=title', 'abcdef123456'), TL_ENGLISH + TL_ENGLISH,
                                                       TL_ENGLISH.replace('<!-- View more jobs button -->', '').rstrip() + TL_ENGLISH.replace('<!-- Job cards -->', '').replace('feedface1234', 'feedface9999'),
                                                       TL_ENGLISH.replace('Taipei, TW', 'Part-time, TW'), TL_ENGLISH.replace('Backend API Engineer', 'Full-time Engineer'),
                                                       TL_ENGLISH.replace('<tr><td></td></tr>', '<tr><td>Extra</td></tr>'), TL_ENGLISH.replace('</a></td></tr>\n<!-- View', '</td></tr>\n<!-- View'),
                                                       TL_ENGLISH.replace('<tr><td>Taipei, TW</td></tr>', '<tr><td>Taipei, <b>TW</b></td></tr>'), TL_ENGLISH.replace('<table>', '<table><tr>'),
                                                       '<!-- Job cards --></tr><!-- View more jobs button -->', '<!-- Job cards --><!-- View more jobs button -->',
                                                       TL_ENGLISH.replace('&amp;user_id=private', ''), TL_ENGLISH.replace('<!-- Job cards -->', '<!--Job cards-->'))],
    tl_message(sender='other@talent.com'), tl_message(subject='驗證信'), tl_message(is_html=False), tl_message(TL_CARD[:-4]), tl_message(TL_CARD * 2),
    tl_message(TL_CARD.replace('<!-- Company -->', '')), tl_message(received='2026-09-26'),
    tl_message(TL_CARD + TL_CARD.replace('abcdef123456', '111111222222')), tl_message(TL_CARD + TL_CARD.replace('abcdef123456', '111111222222').replace('Backend API Engineer', 'Full-time X')),
    tl_message(TL_CARD.replace('Contractor building', 'Building')), tl_message(TL_CARD.replace('<td></td>', '<td>NT$ 1,000</td>')), tl_message(TL_CARD.replace('<td>Taiwan</td>', '<td></td>')),
    tl_message(TL_CARD.replace('<!-- Location -->', '<!--Location-->')), tl_message(TL_CARD.replace('<!-- Location -->', '<!-- Salary -->')),
    tl_message(TL_CARD.replace('class="job__link"', 'class="x job__link y"')), tl_message(TL_CARD.replace('class="job__link"', 'class')),
    tl_message(TL_CARD.replace('class="job__link"', '')), tl_message(TL_CARD.replace('<!-- Title -->', '<!-- Title --><!-- Title -->')),
    tl_message('<!-- Title -->' + TL_CARD), tl_message(TL_CARD + '</a>'), tl_message(TL_CARD.replace('</a>\n<!-- Location', '\n<!-- Location')),
    tl_message(TL_CARD.replace('Example', 'Ex&amp;mple')), tl_message(TL_CARD.replace('<td>Taiwan</td>', '<td>  Tai\n wan </td>')),
    tl_message('<p>header</p>' + TL_CARD + '<p>footer</p>'), tl_message(TL_CARD + '<a>'), tl_message(TL_CARD + '<a class>x</a>'), tl_message('<a class>x</a>' + TL_CARD), tl_message(TL_CARD + '<a href="x">trailing'), tl_message(TL_CARD, subject='更多职位，例如'), tl_message(TL_CARD, subject='更多职位，例如x\n'),
]
GD_URL = 'https://www.glassdoor.com/partner/jobListing.htm?jobListingId=1010273135749'
GD_CARD = '<a href="' + GD_URL + '&tracking=private"><table><tr><td><span><span>Example Co</span></span></td></tr><tr><td><p>AI Agent Engineer</p></td><td><p>2d</p></td></tr></table></a>'
GD_SUBJECT = 'All the top jobs for Software Engineer in Taiwan. Ready to apply?'


def gd_message(body=GD_CARD, **kw):
    """backend/tests/collection/test_glassdoor_mail.py:setUp"""
    kw = dict(sender=glassdoor_mail.SENDER, subject=GD_SUBJECT, mid='synthetic', received='2026-09-26T13:12:00+00:00') | kw
    return message(body, **kw)


GLASSDOOR_CANONICAL = [GD_URL, GD_URL + '&tracking=private', GD_URL.replace('https:', 'http:'), GD_URL.replace('.com/', '.com.evil/'), GD_URL + '&jobListingId=1010273135827',
                       GD_URL + '#tracking', GD_URL.replace('1010273135749', 'not-an-id'), GD_URL.replace('www.glassdoor.com', 'user@www.glassdoor.com'),
                       GD_URL.replace('1010273135749', '123456789'), GD_URL.replace('1010273135749', '1' * 21), GD_URL.replace('1010273135749', '１010273135749'),
                       GD_URL.replace('jobListingId', 'jobListingI%64'), GD_URL + '&' + '&'.join(['x=1'] * 48), GD_URL + '&' + '&'.join(['x=1'] * 49), None, 'x' * 8193,
                       'https://www.glassdoor.com/partner/jobListing.htm', 'https://www.glassdoor.com/Job/jobListing.htm?jobListingId=1010273135749']
GD_BODY_EDGES = [GD_CARD * 2, GD_CARD[:-4], 'No jobs', GD_CARD.replace('<p>AI Agent Engineer</p>', ''), GD_CARD.replace('2d', 'yesterday'), GD_CARD.replace('</span></span>', '</span>'),
                 GD_CARD.replace('Example Co', '<script>bad</script>'), GD_CARD.replace('<p>2d', '<p>Unexpected field</p><p>2d'), GD_CARD.replace('<p>2d', '<p>Easy Apply</p><p>2d'),
                 GD_CARD.replace('2d', '7h'), GD_CARD.replace('2d', 'Just posted'), GD_CARD.replace('2d', '１2d'), GD_CARD.replace('2d', '1000d'), GD_CARD.replace('2d', ' 2d '),
                 GD_CARD + '<a href="https://example.com/private">Unsubscribe</a>', GD_CARD.replace('AI Agent Engineer', 'Full-time AI Agent Engineer'),
                 GD_CARD.replace('AI Agent Engineer', 'Contract AI Engineer'), GD_CARD + GD_CARD.replace('1010273135749', '1010273135827'),
                 GD_CARD.replace('<table>', '<table>stray'), GD_CARD.replace('Example Co', 'Example <b>Co</b>'), GD_CARD.replace('<p>AI', '<p><p>AI'), GD_CARD.replace('</table>', '</p></table>'),
                 GD_CARD.replace('<a href', '<a href="x"><a href'), GD_CARD.replace(GD_URL + '&tracking=private', 'https://example.com/jobListing'), '<a href>x</a>' + GD_CARD,
                 GD_CARD.replace('<span><span>', '<span><span><style>x</style>'), GD_CARD.replace('Example Co', 'x' * 501), GD_CARD.replace('AI Agent Engineer', 'x' * 1001),
                 GD_CARD.replace('</span></span>', '</span></span></span>'), (GD_CARD.replace('1010273135749', '%d') * 101) % tuple(1010273135000 + i for i in range(101)),
                 GD_CARD.replace('<p>2d</p>', '<p>Easy Apply</p><p>Easy Apply</p><p>2d</p>'), GD_CARD.replace('<p>2d</p>', ''), GD_CARD.replace('Example Co', '  ')]
GLASSDOOR_MESSAGES = [gd_message(), *[gd_message(b) for b in GD_BODY_EDGES],
                      gd_message(sender='other@example.com'), gd_message(subject='Welcome to Glassdoor'), gd_message(is_html=False), gd_message(received='2026-09-26'),
                      gd_message(subject='Software Engineer at Example and 6 more jobs in Taiwan for you. Apply Now.'),
                      gd_message(subject='Software Engineer at Example and 6 more jobs in Taiwan for you. Apply Now.', mid='other', received='2026-09-30T00:00:00+00:00'),
                      gd_message(received='2026-09-26T13:12:00Z'), gd_message(subject='All the top jobs for . Ready to apply?'), gd_message(subject='A at B and 1000 more jobs in C for you. Apply Now.')]
MATCH_9B = [{'from': f, 'subject': s} for f in ('Talent <no-reply@alerts.talent.com>', 'noreply@glassdoor.com', 'NoReply@Glassdoor.com', 'attacker@example.com')
            for s in ('更多职位，例如Engineer', TL_EN_SUBJECT, 'Verify your account', GD_SUBJECT, 'Software Engineer at Example and 6 more jobs in Taiwan for you. Apply Now.',
                      'Welcome to Glassdoor', None, '')]


def received_for(source, body, title, **changes):
    return received_mail(**{'from': rp.SENDERS[source]}, subject=title, html=body) | changes


MAIL9B = {
    'cake': (cake_message().body, cake_message().subject), 'jobbank104': (jb_message().body, jb_message().subject),
    'talent': (TL_CARD, '更多职位，例如Engineer'), 'glassdoor': (GD_CARD, GD_SUBJECT),
}
READ_9B = [(s, received_for(s, b, subj, **ch)) for s, (b, subj) in MAIL9B.items() for ch in (
    {}, {'to': ['other@example.test'], 'received_for': []}, {'from': 'imposter@example.com'}, {'html': None, 'text': 'Unsupported private message'}, {'subject': 'Private account notice'})]


def sync9b(source, body, subject):
    first = received_for(source, body, subject)
    replay = received_for(source, body, subject, created_at='2026-09-27T00:00:00Z')
    bad = received_for(source, body, subject, id=mail_id(0x22222222), html='<p>unsupported</p>')
    return dict(source=source, runs=[
        dict(pages=listing_page([])), dict(pages=listing_page([first]) | bodies(first)), dict(pages=listing_page([first]) | bodies(replay)),
        dict(pages=listing_page([bad, first]) | bodies(bad))])


MAIL_SCENARIOS_9B = {f'{s}_waiting_ok_replay_quarantine': sync9b(s, b, subj) for s, (b, subj) in MAIL9B.items()}
MAIL_SCENARIOS_9B['talent_card_without_company_once'] = dict(source='talent', runs=[
    dict(pages=listing_page([received_for('talent', TL_ENGLISH.replace('Example Company', ''), TL_EN_SUBJECT)]) |
         bodies(received_for('talent', TL_ENGLISH.replace('Example Company', ''), TL_EN_SUBJECT)))] * 2)
MAIL_SCENARIOS_9B['glassdoor_bad_then_good'] = dict(source='glassdoor', runs=[
    dict(pages=listing_page([received_for('glassdoor', GD_CARD[:-4], GD_SUBJECT, id=mail_id(0x22222222)), received_for('glassdoor', GD_CARD, GD_SUBJECT)]) |
         bodies(received_for('glassdoor', GD_CARD[:-4], GD_SUBJECT, id=mail_id(0x22222222)), received_for('glassdoor', GD_CARD, GD_SUBJECT)))])


def parse_case(fn, m):
    return dict(message=tag_message(m), expect=attempt(lambda: encode(fn(m))))


def mail9b_golden():
    return {
        'html_events': [dict(input=d, close=c, expect=html_events(d, c)) for d in HTML_EVENTS for c in (False, True)],
        'cake_canonical': [dict(input=tag(u), expect=attempt(lambda: cake_mail.canonical(u))) for u in CAKE_CANONICAL],
        'talent_canonical': [dict(input=tag(u), expect=attempt(lambda: list(talent_mail.canonical(u)))) for u in TALENT_CANONICAL],
        'glassdoor_canonical': [dict(input=tag(u), expect=attempt(lambda: list(glassdoor_mail.canonical(u)))) for u in GLASSDOOR_CANONICAL],
        'cake_parse': [parse_case(cake_mail.parse_cake, m) for m in CAKE_MESSAGES],
        'jobbank104_parse': [parse_case(jobbank104_mail.parse_104, m) for m in JB_MESSAGES],
        'talent_parse': [parse_case(talent_mail.parse_talent, m) for m in TALENT_MESSAGES],
        'glassdoor_parse': [parse_case(glassdoor_mail.parse_glassdoor, m) for m in GLASSDOOR_MESSAGES],
        'resend_matches_9b': [dict(entry=tag(e), source=s, expect=bool(rp.matches(e, s))) for e in MATCH_9B for s in ('talent', 'glassdoor')],
        'read_notification_9b': [rn_case(s, m) for s, m in READ_9B],
        'mail_sync_9b': {name: run_mail_scenario(sc) for name, sc in MAIL_SCENARIOS_9B.items()},
    }



def failure_reasons():
    """Plan step 10a: what each non-mail sync returns when every fetch fails. The network is cut at
    urllib's opener and at socket.connect, so no request leaves the machine."""
    from importlib import import_module
    import socket
    import urllib.request
    from freelance.modules.collection.source_catalog import REGISTRY
    out = {}
    with tempfile.TemporaryDirectory() as tmp:
        store = SQLiteStore(Path(tmp) / 'golden.db', clock=lambda: NOW)
        store.migrate()
        with patch.object(urllib.request.OpenerDirector, 'open', side_effect=OSError('offline')), \
             patch.object(socket.socket, 'connect', side_effect=OSError('offline')):
            for name, spec in REGISTRY.items():
                if not spec.runner or spec.runner == 'resend_sync':
                    continue
                run = getattr(import_module('freelance.modules.collection.' + spec.runner), spec.function)
                out[name] = attempt(lambda: encode(run(name, store) if spec.keyed else run(store)))
    return out


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
        'py_float': [dict(input=s, expect=attempt(lambda: repr(float(s)))) for s in FLOATS],
        'fromtimestamp': [dict(input=tag(t), expect=attempt(lambda: datetime.fromtimestamp(t, timezone.utc).isoformat())) for t in FROMTS],
        'py_re': [re_case(p, f, s) for p, f in COMMUNITY_RES for s in RE_TEXT],
        'himalayas_normalize': [dict(payload=tag(p), expect=attempt(lambda: encode(himalayas.normalize(p)))) for p in HIMALAYAS],
        'himalayas_fetch': [hima_fetch_case(p) for p in HIMALAYAS_FETCH],
        'getonboard_normalize': [dict(item=tag(i), expect=attempt(lambda: encode(getonboard.normalize(i, MOD)))) for i in GETONBOARD],
        'getonboard_modalities': tag(MOD),
        'getonboard_fetch': [gob_fetch_case(p) for p in GETONBOARD_FETCH],
        'hn_job': [hn_case(p, parent) for p, parent in HN],
        'v2ex_jobs': [v2ex_case(d, d.encode('utf-8')) for d in V2EX],
        'hn_fetch': [hn_fetch_case(p) for p in HN_FETCH],
        'xml_attrib': [xml_attrib_case(d) for d in XML_ATTRIB],
        'xml_str': [pf_xml_str_case(d) for d in XML_STR],
        'pf_re': [pf_re_case(p, f, g, s) for p, f, g in PF_RES for s in PF_RE_TEXT],
        'public_feeds_normalize': [pf_normalize_case(src, e) for src, e in PF_NORMALIZE],
        'public_feeds_batch': [pf_batch_case(src, raw) for src, raw in PF_BATCH],
        **batch3_golden(),
        **batch4_golden(),
        **mail_golden(),
        **mail9b_golden(),
        'failure_reasons': failure_reasons(),
    }
    for name, ops in SCENARIOS.items():
        results, tables = run_scenario(ops)
        golden['scenarios'][name] = dict(ops=[tag_op(op) for op in ops], results=results, tables=tables)
    (HERE / 'golden.json').write_text(json.dumps(golden, ensure_ascii=False, indent=0) + '\n')
    counts = {k: len(v) for k, v in golden.items() if isinstance(v, (list, dict))}
    print(counts)


if __name__ == '__main__':
    main()

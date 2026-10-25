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
    }
    for name, ops in SCENARIOS.items():
        results, tables = run_scenario(ops)
        golden['scenarios'][name] = dict(ops=[tag_op(op) for op in ops], results=results, tables=tables)
    (HERE / 'golden.json').write_text(json.dumps(golden, ensure_ascii=False, indent=0) + '\n')
    counts = {k: len(v) for k, v in golden.items() if isinstance(v, (list, dict))}
    print(counts)


if __name__ == '__main__':
    main()

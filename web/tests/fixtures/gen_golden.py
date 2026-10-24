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
    }
    for name, ops in SCENARIOS.items():
        results, tables = run_scenario(ops)
        golden['scenarios'][name] = dict(ops=[tag_op(op) for op in ops], results=results, tables=tables)
    (HERE / 'golden.json').write_text(json.dumps(golden, ensure_ascii=False, indent=0) + '\n')
    counts = {k: len(v) for k, v in golden.items() if isinstance(v, (list, dict))}
    print(counts)


if __name__ == '__main__':
    main()

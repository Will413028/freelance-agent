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
    '2099-01-01', '2026-09-16', '2026-09-17T08:00:00Z', '2026-09-17 08:00:00', '2026-09-17T08:00:00+08:00',
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
    }
    for name, ops in SCENARIOS.items():
        results, tables = run_scenario(ops)
        golden['scenarios'][name] = dict(ops=[tag_op(op) for op in ops], results=results, tables=tables)
    (HERE / 'golden.json').write_text(json.dumps(golden, ensure_ascii=False, indent=0) + '\n')
    counts = {k: len(v) for k, v in golden.items() if isinstance(v, (list, dict))}
    print(counts)


if __name__ == '__main__':
    main()

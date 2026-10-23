"""Bounded source collection using the explicit registry."""
from importlib import import_module
from .source_catalog import REGISTRY, enabled_sources

def collect_sources(connection, repository, *, inbox, freelancer=False, free_boards=False,
                    linkedin=False, cake=False, jobbank104=False, talent=False, sources=None):
    selected = enabled_sources(sources=sources, freelancer=freelancer, free_boards=free_boards,
                               linkedin=linkedin, cake=cake, jobbank104=jobbank104, talent=talent)
    results = {}
    for source in selected:
        spec = REGISTRY[source]
        runner = getattr(import_module('.' + spec.runner, __package__), spec.function)
        if spec.runner == 'resend_sync':
            if connection is None:
                repository.set_source_health(source, 'failed')
                results[source] = {'status': 'failed', 'reason': 'source_unavailable'}
            else:
                results[source] = runner(connection, repository, inbox, max_messages=20)
        else:
            results[source] = runner(source, repository) if spec.keyed else runner(repository)
    ok = all(result['status'] in ('ok', 'waiting') for result in results.values())
    return {'status': 'ok' if ok else 'failed',
            'reason': None if ok else 'one_or_more_sources_failed', **results}

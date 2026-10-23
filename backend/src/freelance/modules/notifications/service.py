"""Daily discovery application use case shared by all entry points."""
from contextlib import contextmanager
from freelance.modules.collection.public import collect_sources
from .daily import run_daily

def run(store, client_factory, *, inbox, recipient, output_dir, now=None, delivery=None, freelancer=False, free_boards=False, linkedin=False, cake=False, jobbank104=False, talent=False, sources=None):
    @contextmanager
    def client():
        try:
            connection = client_factory()
        except Exception:
            connection = None
        yield connection
    def collect(connection, repository):
        return collect_sources(connection, repository, inbox=inbox, freelancer=freelancer,
                               free_boards=free_boards, linkedin=linkedin, cake=cake,
                               jobbank104=jobbank104, talent=talent, sources=sources)
    return run_daily(store, client, recipient=recipient, output_dir=output_dir, now=now,
                     delivery=delivery, source_sync=collect)

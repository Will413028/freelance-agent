import unittest

from copy import deepcopy

from datetime import datetime, timezone

import freelance.modules.discovery.domain as domain

from freelance.legacy.proposals import draft

def job(**changes):
    base = dict(source="freelancer", external_id="101", title="AI agent workflow",
                description="Build an agent with tool calling and API integration.",
                url="https://www.freelancer.com/projects/example-101", kind="fixed",
                currency="TWD", budget_min=4000, budget_max=8000,
                weekly_hours=10, taiwan_eligible=True, timezone_compatible=True,
                deadline="2099-01-01", language="en", complete=True)
    if 'external_id' in changes and 'url' not in changes:
        base['url'] = 'https://www.freelancer.com/projects/example-' + str(changes['external_id'])
    return base | changes

def legacy_proposal(store, item):
    """Seed a pre-discovery template to verify preservation of historical data."""
    item.update(proposal=draft(item['job'], item['evaluation']), draft_method='範本草稿（尚未連接 LLM）')
    if hasattr(store, '_connect'):
        with store._connect() as conn:
            store._save(conn, item)
    else:
        store._items[item['id']] = deepcopy(item)
    return item

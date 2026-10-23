"""Compatibility codec owning historical opportunity/proposal row envelopes."""
import json
from freelance.modules.discovery.rules import evaluate
from freelance.platform.sqlite import encode

class Records:
    def __init__(self, database, settings):
        self.database, self.settings = database, settings

    def get(self, conn, key):
        row = conn.execute('SELECT item FROM opportunities WHERE id=?', (key,)).fetchone()
        return json.loads(row['item']) if row else None

    def all(self, conn):
        return [json.loads(row['item']) for row in conn.execute('SELECT item FROM opportunities ORDER BY id')]

    def for_source(self, conn, source):
        return [json.loads(row['item']) for row in conn.execute(
            'SELECT item FROM opportunities WHERE source=?', (source,))]

    def insert(self, conn, item):
        conn.execute('INSERT INTO opportunities(id,source,external_id,item) VALUES (?,?,?,?)',
                     (item['id'], item['job']['source'], item['job']['external_id'], encode(item)))

    def new_observation(self, key, job, fingerprint, evaluation, old=None):
        item = dict(id=key, job=job, fingerprint=fingerprint, evaluation=evaluation,
                    proposal='', version=old['version'] + 1 if old else 1,
                    review_status='draft', approved_hash=None, skip_reason='',
                    draft_method='未建立提案', delivery_mode='manual')
        if old and old['review_status'] == 'skipped':
            item.update(review_status='skipped', skip_reason=old['skip_reason'])
        return item

    def feedback_changed(self, conn, item, feedback, now):
        if feedback == 'skipped' and item['review_status'] == 'approved':
            item.update(review_status='draft', approved_hash=None, version=item['version'] + 1)
        if feedback in ('neutral', 'interested') and item['review_status'] == 'skipped':
            item.update(review_status='draft', skip_reason='', approved_hash=None, version=item['version'] + 1)
        self.save(conn, item)
        return self.refresh(conn, item, now)

    def save(self, conn, item):
        conn.execute('UPDATE opportunities SET item=? WHERE id=?', (encode(item), item['id']))
        if not item.get('proposal'):
            return
        conn.execute('''INSERT INTO proposal_revisions(opportunity_id, version, proposal, fingerprint)
                        VALUES (?,?,?,?) ON CONFLICT DO NOTHING''',
                     (item['id'], item['version'], item['proposal'], item['fingerprint']))


    def refresh(self, conn, item, now):
        old_evaluation = item.get('evaluation')
        old_review = item['review_status']
        item['evaluation'] = evaluate(item['job'], self.settings.read(conn)['settings'], now)
        if item['evaluation']['status'] != 'qualified' and item['review_status'] == 'approved':
            item.update(review_status='draft', approved_hash=None, version=item['version'] + 1)
        if item['evaluation'] != old_evaluation or item['review_status'] != old_review:
            self.save(conn, item)
        return item

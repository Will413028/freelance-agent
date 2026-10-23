"""Immutable digests, delivery claims and daily run receipts."""
import json
from uuid import uuid4
from freelance.modules.discovery.public import group_items, novelty, unseen as is_unseen, public_item
from freelance.platform.sqlite import encode
from freelance.modules.discovery.public import is_candidate

def _decode(row, field):
    if row is None:
        return None
    decoded = dict(row)
    if decoded[field] is not None:
        decoded[field] = json.loads(decoded[field])
    return decoded

class Notifications:
    def __init__(self, database, discovery, collection):
        self.database, self.discovery, self.collection = database, discovery, collection

    def operations(self):
        """Non-sensitive observations; latest check and daily evidence remain separate."""
        with self.database.connect(write=False) as conn:
            sources = self.collection.source_checks_in(conn)
            run = conn.execute('''SELECT r.local_date,r.status,r.started_at,r.finished_at,r.result,
                                    o.status AS delivery_status
                                 FROM daily_runs r LEFT JOIN digest_outbox o
                                   ON o.local_date=r.local_date AND o.recipient=r.recipient
                                 ORDER BY r.local_date DESC,r.started_at DESC LIMIT 1''').fetchone()
            run = _decode(run, 'result')
            last_run = ({key: run[key] for key in ('local_date','status','started_at','finished_at','delivery_status')}
                        if run else None)
            details = (run['result'] or {}).get('source_details', {}) if run else {}
            for source, check in sources.items():
                observed = details.get(source) if isinstance(details, dict) else None
                check['latest_daily'] = None
                if not isinstance(observed, dict):
                    continue
                status = observed.get('status')
                summary = {'local_date': run['local_date'],
                           'status': status if status in ('ok','failed','partial','waiting') else 'unknown'}
                for key in ('seen','jobs','rejected_count','pages','quarantined','error_count','metadata_seen','body_reads','messages'):
                    value = observed.get(key)
                    summary[key] = value if type(value) is int and value >= 0 else None
                for key in ('truncated','limited','complete_scan'):
                    value = observed.get(key)
                    summary[key] = value if type(value) is bool else None
                summary['reason'] = ('invalid_data' if (summary['rejected_count'] or summary['quarantined'])
                                     else 'incomplete_scan' if (summary['truncated'] or summary['limited'])
                                     else 'source_error' if summary['status'] == 'failed'
                                     else 'waiting_for_notification' if summary['status'] == 'waiting' else None)
                check['latest_daily'] = summary
            return {'last_run': last_run, 'sources': sources}

    def create_digest(self, local_date, recipient, now):
        with self.database.connect() as conn:
            existing = conn.execute('SELECT * FROM digest_outbox WHERE local_date=? AND recipient=?', (str(local_date), recipient)).fetchone()
            if existing:
                return _decode(existing, 'snapshot')
            all_items = self.discovery.list_in(conn, now)
            candidates = [item for item in group_items(all_items) if is_candidate(item)]
            seen = set()
            for prior in conn.execute("SELECT snapshot FROM digest_outbox WHERE recipient=? AND status IN ('sent','attempted','unknown')", (recipient,)):
                for item in json.loads(prior['snapshot'])['items']:
                    seen.update(novelty(item))
            unseen = [item for item in candidates if is_unseen(item, seen)]
            items = [public_item(item) | {'fingerprint': item['fingerprint'], 'novelty_keys': item['novelty_keys']}
                     for item in unseen]
            snapshot = dict(items=items, candidate_count=len(candidates), unseen_count=len(unseen),
                            suppressed_count=len(candidates)-len(unseen),
                            sources=self.collection.sources_in(conn), generated_at=now.isoformat(),
                            recipient=recipient, local_date=str(local_date))
            row = conn.execute('''INSERT INTO digest_outbox(id,local_date,recipient,snapshot)
                                   VALUES (?,?,?,?) RETURNING *''',
                                (str(uuid4()), str(local_date), recipient, encode(snapshot))).fetchone()
            return _decode(row, 'snapshot')


    def find_digest(self, local_date, recipient):
        with self.database.connect(write=False) as conn:
            row = conn.execute('SELECT * FROM digest_outbox WHERE local_date=? AND recipient=?',
                                (str(local_date), recipient)).fetchone()
            return _decode(row, 'snapshot')


    def get_digest(self, intent_id):
        with self.database.connect(write=False) as conn:
            result = conn.execute('SELECT * FROM digest_outbox WHERE id=?', (intent_id,)).fetchone()
            if not result:
                raise KeyError(intent_id)
            return _decode(result, 'snapshot')


    def claim_digest(self, intent_id):
        # The commit happens before returning, and therefore before any sender call.
        with self.database.connect() as conn:
            row = conn.execute('''UPDATE digest_outbox SET status='attempted', attempted_at=CURRENT_TIMESTAMP
                                   WHERE id=? AND status='pending' RETURNING *''', (intent_id,)).fetchone()
            return _decode(row, 'snapshot')


    def finish_digest(self, intent_id, status, receipt=None):
        if status not in ('sent', 'unknown'):
            raise ValueError('Only sent or unknown delivery outcomes are supported')
        if status == 'sent' and (not isinstance(receipt, str) or not receipt.strip()):
            raise ValueError('sent requires a provider receipt')
        with self.database.connect() as conn:
            conn.execute('''UPDATE digest_outbox SET status=?, delivery_receipt=?, finished_at=CURRENT_TIMESTAMP
                            WHERE id=? AND status='attempted' ''', (status, receipt, intent_id))
        return self.get_digest(intent_id)


    def claim_daily_run(self, local_date, recipient, now):
        with self.database.connect() as conn:
            result = conn.execute("""INSERT INTO daily_runs(local_date,recipient,status,started_at)
                                     VALUES (?,?,'running',?) ON CONFLICT DO NOTHING""",
                                  (str(local_date), recipient, now.isoformat()))
            return result.rowcount == 1


    def get_daily_run(self, local_date, recipient):
        with self.database.connect(write=False) as conn:
            row = conn.execute('SELECT * FROM daily_runs WHERE local_date=? AND recipient=?',
                                (str(local_date), recipient)).fetchone()
            return _decode(row, 'result')


    def finish_daily_run(self, local_date, recipient, status, result, now):
        if status not in ('complete', 'failed'):
            raise ValueError('Invalid daily run outcome')
        with self.database.connect() as conn:
            conn.execute("""UPDATE daily_runs SET status=?,result=?,finished_at=?
                            WHERE local_date=? AND recipient=? AND status='running'""",
                         (status, encode(result), now.isoformat(), str(local_date), recipient))

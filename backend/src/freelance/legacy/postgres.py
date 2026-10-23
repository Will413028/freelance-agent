"""Explicit PostgreSQL repository. Construction never connects or migrates."""
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from freelance.legacy.proposals import draft
from freelance.modules.discovery.domain import qualify
from freelance.legacy.review import Conflict, InvalidAction, older_notification

SOURCES = ('freelancer', 'tasker', 'flexjobs', 'justremote', 'remoters', 'toptal')


def _hash(value):
    return sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class PostgresStore:
    def __init__(self, dsn, clock=None):
        self.dsn = dsn
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def _connect(self):
        return psycopg.connect(self.dsn, row_factory=dict_row)

    def migrate(self):
        from importlib.resources import files
        sql = files('freelance.platform').joinpath('schema/001_initial.sql').read_text()
        with self._connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('freelance-migration', 0))")
            conn.execute(sql)

    def _save(self, conn, item):
        conn.execute('UPDATE opportunities SET item=%s WHERE id=%s', (Jsonb(item), item['id']))
        conn.execute('''INSERT INTO proposal_revisions(opportunity_id, version, proposal, fingerprint)
                        VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING''',
                     (item['id'], item['version'], item['proposal'], item['fingerprint']))

    def _refresh(self, conn, item, now):
        item['evaluation'] = qualify(item['job'], now=now)
        if item['evaluation']['status'] != 'qualified' and item['review_status'] == 'approved':
            item.update(review_status='draft', approved_hash=None, version=item['version'] + 1)
        self._save(conn, item)
        return item

    def ingest(self, job, receipt_id=None):
        """receipt_id identifies ONE normalized listing occurrence.

        For multi-listing notifications use message_id + listing identity; keep
        the raw message reference in job.evidence_ref. It is not a Gmail ID alone.
        """
        if not isinstance(job.get('source'), str) or not job['source'] or not isinstance(job.get('external_id'), str) or not job['external_id']:
            raise ValueError('source and external_id must be nonempty strings')
        key = _hash([job['source'], job['external_id']])
        fingerprint = _hash({k: v for k, v in job.items() if k not in {'received_at', 'receipt_id', 'evidence_ref', 'raw_evidence_ref'}})
        if receipt_id is not None and (not isinstance(receipt_id, str) or not receipt_id):
            raise ValueError('receipt_id must be a nonempty string')
        with self._connect() as conn:
            # Serializes the absent-row case too; UNIQUE remains the final DB guard.
            conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', (key,))
            row = conn.execute('SELECT item FROM opportunities WHERE id=%s FOR UPDATE', (key,)).fetchone()
            old = row['item'] if row else None
            if receipt_id is not None:
                existing_receipt = conn.execute(
                    'SELECT opportunity_id FROM source_receipts WHERE source=%s AND receipt_id=%s',
                    (job['source'], receipt_id)).fetchone()
                if existing_receipt:
                    if existing_receipt['opportunity_id'] != key:
                        raise Conflict('Receipt already belongs to another opportunity')
                    return self._refresh(conn, old, self.clock())
            if old and older_notification(job, old['job']):
                item = self._refresh(conn, old, self.clock())
            elif old and old['fingerprint'] == fingerprint:
                item = old
                item['job'] = job
                self._refresh(conn, item, self.clock())
            else:
                evaluation = qualify(job, now=self.clock())
                item = dict(id=key, job=job, fingerprint=fingerprint, evaluation=evaluation,
                            proposal=draft(job, evaluation), version=old['version'] + 1 if old else 1,
                            review_status='draft', approved_hash=None, skip_reason='',
                            draft_method='範本草稿（尚未連接 LLM）', delivery_mode='manual')
                if old and old['review_status'] == 'skipped':
                    item.update(review_status='skipped', skip_reason=old['skip_reason'])
                if not old:
                    conn.execute('INSERT INTO opportunities(id,source,external_id,item) VALUES (%s,%s,%s,%s)',
                                 (key, job['source'], job['external_id'], Jsonb(item)))
                self._save(conn, item)
            if receipt_id is not None:
                conn.execute('''INSERT INTO source_receipts(source,receipt_id,opportunity_id)
                                VALUES (%s,%s,%s) ON CONFLICT DO NOTHING''', (job['source'], receipt_id, key))
                receipt = conn.execute('SELECT opportunity_id FROM source_receipts WHERE source=%s AND receipt_id=%s',
                                       (job['source'], receipt_id)).fetchone()
                if receipt['opportunity_id'] != key:
                    raise Conflict('Receipt already belongs to another opportunity')
            return item

    def _list(self, conn, now):
        rows = conn.execute('SELECT item FROM opportunities ORDER BY id FOR UPDATE').fetchall()
        items = [self._refresh(conn, row['item'], now) for row in rows]
        return sorted(items, key=lambda x: (-x['evaluation']['score'], x['id']))

    def list(self):
        with self._connect() as conn:
            return self._list(conn, self.clock())

    def review(self, key, action, version, text='', reason=''):
        with self._connect() as conn:
            row = conn.execute('SELECT item FROM opportunities WHERE id=%s FOR UPDATE', (key,)).fetchone()
            if not row:
                raise KeyError(key)
            item = row['item']
            if isinstance(version, bool) or not isinstance(version, int) or version != item['version']:
                raise Conflict('草稿已更新，請重新載入後確認')
            if action == 'edit':
                if not isinstance(text, str) or not text.strip() or len(text) > 10000:
                    raise InvalidAction('申請稿需為 1–10000 字')
                item.update(proposal=text.strip(), version=version + 1, review_status='draft', approved_hash=None)
            elif action == 'approve':
                item['evaluation'] = qualify(item['job'], now=self.clock())
                if item['evaluation']['status'] != 'qualified' or item['review_status'] == 'skipped':
                    raise InvalidAction('案件仍有未確認條件或已略過，無法核准')
                item.update(review_status='approved', approved_hash=sha256(item['proposal'].encode()).hexdigest())
            elif action == 'skip':
                if not isinstance(reason, str) or not reason.strip() or len(reason) > 500:
                    raise InvalidAction('請填寫 1–500 字略過原因')
                item.update(review_status='skipped', skip_reason=reason.strip(), approved_hash=None)
            else:
                raise InvalidAction('不支援的操作；尚未配置投遞 adapter')
            self._save(conn, item)
            return item

    def set_source_health(self, source, status):
        if source not in SOURCES or status not in ('not_connected', 'ok', 'failed'):
            raise ValueError('unknown source or source status')
        with self._connect() as conn:
            conn.execute('''INSERT INTO source_health(source,status) VALUES (%s,%s)
                            ON CONFLICT(source) DO UPDATE SET status=excluded.status, checked_at=now()''', (source, status))

    def _sources(self, conn):
        return dict.fromkeys(SOURCES, 'not_connected') | {
            x['source']: x['status'] for x in conn.execute('SELECT source,status FROM source_health')}

    def sources(self):
        with self._connect() as conn:
            return self._sources(conn)

    def create_digest(self, local_date, recipient, now):
        with self._connect() as conn:
            conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))',
                         (_hash([str(local_date), recipient]),))
            existing = conn.execute('SELECT * FROM digest_outbox WHERE local_date=%s AND recipient=%s', (local_date, recipient)).fetchone()
            if existing:
                return existing
            items = [x for x in self._list(conn, now)
                     if x['review_status'] not in ('skipped', 'sent', 'delivered') and x['evaluation']['status'] != 'excluded']
            snapshot = dict(items=items, sources=self._sources(conn), generated_at=now.isoformat(),
                            recipient=recipient, local_date=str(local_date))
            return conn.execute('''INSERT INTO digest_outbox(id,local_date,recipient,snapshot)
                                   VALUES (%s,%s,%s,%s) RETURNING *''',
                                (str(uuid4()), local_date, recipient, Jsonb(snapshot))).fetchone()

    def get_digest(self, intent_id):
        with self._connect() as conn:
            result = conn.execute('SELECT * FROM digest_outbox WHERE id=%s', (intent_id,)).fetchone()
            if not result:
                raise KeyError(intent_id)
            return result

    def claim_digest(self, intent_id):
        # The commit happens before returning, and therefore before any sender call.
        with self._connect() as conn:
            return conn.execute('''UPDATE digest_outbox SET status='attempted', attempted_at=now()
                                   WHERE id=%s AND status='pending' RETURNING *''', (intent_id,)).fetchone()

    def finish_digest(self, intent_id, status, receipt=None):
        if status not in ('sent', 'unknown'):
            raise ValueError('Only sent or unknown delivery outcomes are supported')
        if status == 'sent' and (not isinstance(receipt, str) or not receipt.strip()):
            raise ValueError('sent requires a provider receipt')
        with self._connect() as conn:
            conn.execute('''UPDATE digest_outbox SET status=%s, delivery_receipt=%s, finished_at=now()
                            WHERE id=%s AND status='attempted' ''', (status, receipt, intent_id))
        return self.get_digest(intent_id)


def main():
    import argparse
    import os
    parser = argparse.ArgumentParser(description='Explicit PostgreSQL migration; no external connectors')
    parser.add_argument('--migrate', action='store_true', required=True)
    parser.parse_args()
    dsn = os.environ.get('FREELANCE_DATABASE_URL')
    if not dsn:
        parser.error('FREELANCE_DATABASE_URL must be explicitly configured')
    try:
        PostgresStore(dsn).migrate()
    except psycopg.Error:
        parser.exit(1, 'Database migration failed; inspect local database configuration.\n')
    print('migration complete')


if __name__ == '__main__':
    main()

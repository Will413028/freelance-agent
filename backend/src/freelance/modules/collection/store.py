"""Source intake, receipts, mailbox cursors and source health."""
from contextlib import nullcontext, contextmanager
from hashlib import sha256
import json
from freelance.modules.discovery.public import evaluate
from freelance.platform.errors import Conflict, InvalidAction
from freelance.modules.collection.observation import older_notification
from freelance.platform.sqlite import encode

def identity_hash(value):
    return sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class SourceBatch:
    """Source-scoped data operations sharing the caller's intake transaction."""
    def __init__(self, collection, conn, source):
        self._collection, self._conn, self.source = collection, conn, source

    def existing_ids(self):
        return {row['external_id'] for row in self._conn.execute(
            'SELECT external_id FROM opportunities WHERE source=?', (self.source,))}

    def existing_jobs(self):
        return {item['job']['external_id']: item['job']
                for item in self._collection.records.for_source(self._conn, self.source)}

    def ingest(self, job, receipt_id=None):
        if job.get('source') != self.source:
            raise ValueError('Wrong intake source')
        return self._collection.ingest(job, receipt_id, _conn=self._conn)

    def finish(self, status):
        self._collection.set_source_health_in(self._conn, self.source, status)

class Collection:
    def __init__(self, database, records, settings, sources):
        self.database, self.records, self.settings = database, records, settings
        self.source_ids = sources

    @contextmanager
    def source_batch(self, source):
        if source not in self.source_ids:
            raise ValueError('unknown source')
        with self.database.connect() as conn:
            yield SourceBatch(self, conn, source)

    def existing_source_ids(self, source):
        if source not in self.source_ids:
            raise ValueError('unknown source')
        with self.database.connect(write=False) as conn:
            return SourceBatch(self, conn, source).existing_ids()

    def content_versions(self, conn):
        return list(conn.execute('SELECT opportunity_id,fingerprint,job FROM mail_content_versions ORDER BY fingerprint'))

    def ingest(self, job, receipt_id=None, *, _conn=None):
        """receipt_id identifies ONE normalized listing occurrence.

        For multi-listing notifications use message_id + listing identity; keep
        the raw message reference in job.evidence_ref. It is not a Gmail ID alone.
        """
        if not isinstance(job.get('source'), str) or not job['source'] or not isinstance(job.get('external_id'), str) or not job['external_id']:
            raise ValueError('source and external_id must be nonempty strings')
        key = identity_hash([job['source'], job['external_id']])
        fingerprint = identity_hash({k: v for k, v in job.items() if k not in {'received_at', 'receipt_id', 'evidence_ref', 'raw_evidence_ref'}})
        if receipt_id is not None and (not isinstance(receipt_id, str) or not receipt_id):
            raise ValueError('receipt_id must be a nonempty string')
        with (self.database.connect() if _conn is None else nullcontext(_conn)) as conn:
            old = self.records.get(conn, key)
            if receipt_id is not None:
                existing_receipt = conn.execute(
                    'SELECT opportunity_id FROM source_receipts WHERE source=? AND receipt_id=?',
                    (job['source'], receipt_id)).fetchone()
                if existing_receipt:
                    if existing_receipt['opportunity_id'] != key:
                        raise Conflict('Receipt already belongs to another opportunity')
                    return self.records.refresh(conn, old, self.database.clock())
            if old and older_notification(job, old['job']):
                item = self.records.refresh(conn, old, self.database.clock())
            elif old and old['fingerprint'] == fingerprint:
                item = old
                item['job'] = job
                self.records.refresh(conn, item, self.database.clock())
            else:
                evaluation = evaluate(job, self.settings.read(conn)['settings'], self.database.clock())
                item = self.records.new_observation(key, job, fingerprint, evaluation, old)
                if not old:
                    self.records.insert(conn, item)
                self.records.save(conn, item)
            if receipt_id is not None:
                conn.execute('''INSERT INTO source_receipts(source,receipt_id,opportunity_id)
                                VALUES (?,?,?) ON CONFLICT DO NOTHING''', (job['source'], receipt_id, key))
                receipt = conn.execute('SELECT opportunity_id FROM source_receipts WHERE source=? AND receipt_id=?',
                                       (job['source'], receipt_id)).fetchone()
                if receipt['opportunity_id'] != key:
                    raise Conflict('Receipt already belongs to another opportunity')
            return item


    def ingest_resend_batch(self, jobs):
        """Keep distinct forwarded observations without choosing a newer source version."""
        new_versions = 0
        with self.database.connect() as conn:
            for job in jobs:
                key = identity_hash([job['source'], job['external_id']])
                record = self.records.get(conn, key)
                fingerprint = identity_hash({k: v for k, v in job.items() if k not in
                                     {'received_at', 'receipt_id', 'evidence_ref', 'raw_evidence_ref'}})
                incoming = job
                if record is not None:
                    if fingerprint != record['fingerprint']:
                        receipt = conn.execute('SELECT opportunity_id FROM source_receipts WHERE source=? AND receipt_id=?',
                                               (job['source'], job['receipt_id'])).fetchone()
                        if receipt and receipt['opportunity_id'] != key:
                            raise Conflict('Receipt already belongs to another opportunity')
                        known = conn.execute('SELECT 1 FROM mail_content_versions WHERE opportunity_id=? AND fingerprint=?',
                                             (key, fingerprint)).fetchone()
                        if receipt and not known:
                            raise Conflict('Receipt reused with different content')
                        original = record
                        conn.execute('''INSERT OR IGNORE INTO mail_content_versions(opportunity_id,fingerprint,job)
                                        VALUES (?,?,?)''', (key, original['fingerprint'], encode(original['job'])))
                        inserted = conn.execute('''INSERT OR IGNORE INTO mail_content_versions(opportunity_id,fingerprint,job)
                                                   VALUES (?,?,?)''', (key, fingerprint, encode(job)))
                        new_versions += inserted.rowcount
                        conn.execute('''INSERT OR IGNORE INTO source_receipts(source,receipt_id,opportunity_id)
                                        VALUES (?,?,?)''', (job['source'], job['receipt_id'], key))
                        continue
                    incoming = record['job']
                self.ingest(incoming, receipt_id=job['receipt_id'], _conn=conn)
        return {'content_versions': new_versions}


    def set_source_health(self, source, status):
        with self.database.connect() as conn:
            self.set_source_health_in(conn, source, status)

    def set_source_health_in(self, conn, source, status):
        if source not in self.source_ids or status not in ('not_connected', 'ok', 'failed', 'waiting'):
            raise ValueError('unknown source or source status')
        conn.execute('''INSERT INTO source_health(source,status) VALUES (?,?)
                        ON CONFLICT(source) DO UPDATE SET status=excluded.status, checked_at=CURRENT_TIMESTAMP''', (source, status))


    def mail_state(self, source, recipient):
        with self.database.connect(write=False) as conn:
            row = conn.execute('SELECT state FROM mail_sync_state WHERE source=? AND recipient=?',
                               (source, recipient)).fetchone()
            return json.loads(row['state']) if row else dict(cursor=None, after=None, head=None)


    def save_mail_state(self, source, recipient, state):
        with self.database.connect() as conn:
            conn.execute('''INSERT INTO mail_sync_state(source,recipient,state) VALUES (?,?,?)
                ON CONFLICT(source,recipient) DO UPDATE SET state=excluded.state''',
                (source, recipient, encode(state)))


    def mail_records(self, source, recipient):
        with self.database.connect(write=False) as conn:
            return {row['message_id']: row for row in conn.execute(
                'SELECT message_id,status,reason,retry_pending FROM mail_ingestion WHERE source=? AND recipient=?',
                (source, recipient))}


    def record_mail(self, source, recipient, message_id, status, reason=None):
        with self.database.connect() as conn:
            conn.execute('''INSERT INTO mail_ingestion(source,recipient,message_id,status,reason)
                VALUES (?,?,?,?,?) ON CONFLICT(source,recipient,message_id) DO UPDATE SET
                status=excluded.status,reason=excluded.reason,retry_pending=0,checked_at=CURRENT_TIMESTAMP
                WHERE mail_ingestion.retry_pending=1''',
                (source, recipient, message_id, status, reason))


    def retry_mail(self, source, recipient, message_id):
        """Explicit local requeue after a parser fix; processed receipts stay intact."""
        with self.database.connect() as conn:
            row = conn.execute('SELECT status FROM mail_ingestion WHERE source=? AND recipient=? AND message_id=?',
                               (source, recipient, message_id)).fetchone()
            if not row or row['status'] != 'rejected':
                raise InvalidAction('僅解析失敗的信件可重試；內容衝突需另行處置')
            conn.execute('UPDATE mail_ingestion SET retry_pending=1 WHERE source=? AND recipient=? AND message_id=?',
                         (source, recipient, message_id))


    def sources_in(self, conn):
        return dict.fromkeys(self.source_ids, 'not_connected') | {
            x['source']: x['status'] for x in conn.execute('SELECT source,status FROM source_health')}


    def sources(self):
        with self.database.connect(write=False) as conn:
            return self.sources_in(conn)

    def source_checks_in(self, conn):
        result = {source: {'status': 'not_connected', 'checked_at': None}
                  for source in self.source_ids}
        for row in conn.execute('SELECT source,status,checked_at FROM source_health'):
            result[row['source']] = {'status': row['status'], 'checked_at': row['checked_at']}
        return result

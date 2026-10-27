"""Isolated candidate for canonical evidence withdrawal in pinned Serein.

NOT registered in the production HTTP host. Requires a quiescent pipeline.
Unbound Scenes and frozen model jobs are an unresolved epoch boundary: the
production SOURCE_RETRACTION_VERIFIED gate must remain false.
"""
import json
import hashlib


class SourceConflict(ValueError):
    pass


class Projector:
    def __init__(self, settings):
        from serein.core.store import Store
        from serein.compat.raw_archive import raw_archive
        self.settings = settings; self.archive = raw_archive(settings)
        with Store(settings.database) as store:
            store.conn.executescript('''
                CREATE TABLE IF NOT EXISTS morrow_source_receipts(id TEXT PRIMARY KEY,hash TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS morrow_source_current(
                    instance TEXT,message TEXT,session TEXT,raw_id INTEGER,PRIMARY KEY(instance,message));
                CREATE TABLE IF NOT EXISTS morrow_source_vault(
                    event_id TEXT,raw_id INTEGER,original_json TEXT NOT NULL,PRIMARY KEY(event_id,raw_id));
            ''')

    def apply(self, event):
        from serein.core.store import Store, encode
        from serein.deployment import read_settings
        if read_settings(self.settings.database)['pipeline']['auto_enabled']:
            raise SourceConflict('Automatic pipeline must be paused before candidate projection')
        stamp = hashlib.sha256(encode(event).encode()).hexdigest()
        with Store(self.settings.database) as store, store.transaction(immediate=True):
            old = store.conn.execute('SELECT hash FROM morrow_source_receipts WHERE id=?', (event['event_id'],)).fetchone()
            if old:
                if old[0] != stamp:
                    raise SourceConflict('Same event ID has different content')
                return {'event_id': event['event_id'], 'state': 'applied'}
            instance, session = str(event['instance_id']), str(event['session_id'])
            message = str(event['message_id'])
            if event['kind'] not in ('upsert', 'withdraw', 'withdraw_session'):
                raise SourceConflict('Unsupported source operation')
            condition, params = ('instance=? AND session=?', (instance, session)) if event['kind']=='withdraw_session' else ('instance=? AND message=?', (instance, message))
            rows = store.conn.execute('SELECT * FROM morrow_source_current WHERE '+condition, params).fetchall()
            for mapping in rows:
                raw = store.conn.execute('SELECT * FROM raw_events WHERE id=?', (mapping['raw_id'],)).fetchone()
                if raw:
                    store.conn.execute('INSERT INTO morrow_source_vault VALUES (?,?,?)',
                        (event['event_id'], raw['id'], encode(dict(raw))))
                    keys = {encode([raw['source'], raw['session_id'], raw['source_event_id']]),
                            encode([raw['source'], raw['session_id'], str(raw['id'])])}
                    # Only explicitly matching evidence is revoked; do not infer
                    # associations from text/semantic similarity.
                    for key in keys:
                        sources = store.conn.execute('SELECT id FROM sources WHERE source_key=?', (key,)).fetchall()
                        for source in sources:
                            bindings = store.conn.execute('SELECT id,document_id FROM evidence_bindings WHERE source_id=? AND active=1', (source[0],)).fetchall()
                            for binding in bindings:
                                store.unbind(binding['id'], actor='morrow_source_withdrawal')
                                store.set_lifecycle(binding['document_id'], 'deleted')
                                store.conn.execute('INSERT INTO index_outbox(document_id) VALUES (?)', (binding['document_id'],))
                    if self.archive.fts_enabled:
                        store.conn.execute('DELETE FROM raw_events_fts WHERE rowid=?', (raw['id'],))
                    store.conn.execute('DELETE FROM raw_events WHERE id=?', (raw['id'],))
            store.conn.execute('DELETE FROM morrow_source_current WHERE '+condition, params)
            payload = event.get('message', {})
            if (event['kind']=='upsert' and not payload.get('hidden') and not payload.get('partial')
                    and payload.get('text') and payload.get('role') in ('user','assistant')):
                normalized, error = self.archive._normalize_event({'source':'morrow:'+instance,
                    'source_event_id':event['event_id'], 'session_id':session, 'conversation_id':session,
                    'role':payload['role'],'text':payload['text'],'created_at':payload['created_at'],
                    'metadata':{'message_id':message,'instance':instance}}, default_source='morrow:'+instance,
                    ingested_at=payload['created_at'])
                if normalized is None:
                    raise SourceConflict('Invalid original message')
                _, raw_id = self.archive._insert_event_on_connection(store.conn, normalized)
                store.conn.execute('INSERT INTO morrow_source_current VALUES (?,?,?,?)', (instance,message,session,raw_id))
            store.conn.execute('INSERT INTO morrow_source_receipts VALUES (?,?)', (event['event_id'],stamp))
        return {'event_id':event['event_id'],'state':'applied'}

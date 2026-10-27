"""Ordered source projection with pinned-runtime transactional withdrawal guards.

The receiver policy remains closed unless separately certified. Event automatic
processing is a separate gate, never enabled by source synchronization.
"""
import json
import hashlib
from datetime import datetime, timedelta, timezone
import source_protocol
from source_protocol import SourceConflict
import serein_source_guard as guard


class Projector:
    def __init__(self, settings):
        guard.install_runtime()
        from serein.core.store import Store
        from serein.compat.raw_archive import raw_archive
        self.settings = settings; self.archive = raw_archive(settings)
        with Store(settings.database,read_only=True) as existing:
            pipeline_exists=existing.conn.execute("SELECT 1 FROM sqlite_master WHERE name='pipeline_batches'").fetchone()
        if not pipeline_exists:
            from serein.extensions.pipeline import initialize as initialize_pipeline
            initialize_pipeline(settings.database)
        with Store(settings.database) as store:
            store.conn.executescript('''
                CREATE TABLE IF NOT EXISTS morrow_source_receipts(id TEXT PRIMARY KEY,hash TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS morrow_source_current(
                    instance TEXT,message TEXT,session TEXT,raw_id INTEGER,PRIMARY KEY(instance,message));
                CREATE TABLE IF NOT EXISTS morrow_source_vault(
                    event_id TEXT,raw_id INTEGER,original_json TEXT NOT NULL,PRIMARY KEY(event_id,raw_id));
                CREATE TABLE IF NOT EXISTS morrow_source_versions(
                    event_id TEXT PRIMARY KEY,instance TEXT NOT NULL,message TEXT NOT NULL,session TEXT NOT NULL,
                    version INTEGER NOT NULL,content_hash TEXT NOT NULL,state TEXT NOT NULL,raw_id INTEGER,
                    original_json TEXT NOT NULL);
            ''')
            with store.transaction(immediate=True):
                if 'original_json' not in {r[1] for r in store.conn.execute('PRAGMA table_info(morrow_source_versions)')}:
                    store.conn.execute("ALTER TABLE morrow_source_versions ADD COLUMN original_json TEXT NOT NULL DEFAULT '{}'")
                source_protocol.initialize(store.conn)
                guard.initialize(store.conn)
            guard.attach(store.conn,settings.database)

    def head(self, instance):
        from serein.core.store import Store
        with Store(self.settings.database, read_only=True) as store:
            return source_protocol.head(store.conn, instance)

    def apply(self, event):
        from serein.core.store import Store, encode
        from serein.deployment import read_settings
        if read_settings(self.settings.database)['pipeline']['auto_enabled']:
            raise SourceConflict('Automatic pipeline must be paused before candidate projection')
        source_protocol.validate(event)
        payload = event['message']
        created_at = None
        if event['kind'] == 'upsert':
            if (payload.get('role') not in ('user', 'assistant') or not isinstance(payload.get('text'), str)
                    or any(type(payload.get(key)) not in (int, bool) or payload[key] not in (0, 1)
                           for key in ('hidden', 'partial'))):
                raise SourceConflict('Invalid original message snapshot')
            try:
                timestamp = payload['created_at']
                if not isinstance(timestamp, str) or ':' not in timestamp:
                    raise ValueError()
                parsed = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                # Morrow's SQLite defaults store an explicit UTC+8 wall clock.
                # Never let the Serein server's timezone reinterpret that clock.
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone(timedelta(hours=8)))
                created_at = parsed.isoformat()
            except (ValueError, TypeError, KeyError):
                raise SourceConflict('Invalid original message timestamp') from None
        stamp = hashlib.sha256(encode(event).encode()).hexdigest()
        with guard.scope(self.settings.database,maintenance=True), Store(self.settings.database) as store, store.transaction(immediate=True):
            previous = source_protocol.check(store.conn, event)
            if previous:
                return previous
            old = store.conn.execute('SELECT hash FROM morrow_source_receipts WHERE id=?', (event['event_id'],)).fetchone()
            if old:
                raise SourceConflict('Legacy receipt lacks an ordered cursor; explicit reconciliation required')
            instance, session = str(event['instance_id']), str(event['session_id'])
            message = str(event['message_id'])
            if event['kind'] not in ('upsert', 'withdraw', 'withdraw_session'):
                raise SourceConflict('Unsupported source operation')
            condition, params = ('instance=? AND session=?', (instance, session)) if event['kind']=='withdraw_session' else ('instance=? AND message=?', (instance, message))
            rows = store.conn.execute('SELECT * FROM morrow_source_current WHERE '+condition, params).fetchall()
            originals = [raw for mapping in rows if (raw := store.conn.execute(
                'SELECT * FROM raw_events WHERE id=?',(mapping['raw_id'],)).fetchone()) is not None]
            if originals or event['kind'] != 'upsert':
                guard.invalidate(store,originals,event['event_id'])
            store.conn.execute("UPDATE morrow_source_versions SET state='revoked' WHERE "+condition,params)
            for mapping in rows:
                raw = store.conn.execute('SELECT * FROM raw_events WHERE id=?', (mapping['raw_id'],)).fetchone()
                if raw:
                    store.conn.execute('INSERT INTO morrow_source_vault VALUES (?,?,?)',
                        (event['event_id'], raw['id'], encode(dict(raw))))
                    if self.archive.fts_enabled:
                        store.conn.execute('DELETE FROM raw_events_fts WHERE rowid=?', (raw['id'],))
                    store.conn.execute('DELETE FROM raw_events WHERE id=?', (raw['id'],))
            store.conn.execute('DELETE FROM morrow_source_current WHERE '+condition, params)
            raw_id = None
            state = 'unavailable'
            if (event['kind']=='upsert' and not payload.get('hidden') and not payload.get('partial')
                    and payload.get('text') and payload.get('role') in ('user','assistant')):
                normalized, error = self.archive._normalize_event({'source':'morrow:'+instance,
                    'source_event_id':event['event_id'], 'session_id':session, 'conversation_id':session,
                    'role':payload['role'],'text':payload['text'],'created_at':created_at,
                    'metadata':{'message_id':message,'instance':instance,'original_created_at':payload['created_at']}},
                    default_source='morrow:'+instance, ingested_at=created_at)
                # Preserve originals losslessly in the private version archive.
                # Do not override upstream injection filtering or silently call
                # sanitized text an exact original: filtered items have no
                # recallable projection and cannot serve as Scene evidence.
                if normalized is not None and normalized['text']==payload['text']:
                    _, raw_id = self.archive._insert_event_on_connection(store.conn, normalized)
                    store.conn.execute('INSERT INTO morrow_source_current VALUES (?,?,?,?)', (instance,message,session,raw_id))
                    state = 'current'
                else:
                    state = 'filtered'
            if event['kind'] == 'upsert':
                version=payload.get('active',0)
                if type(version) is not int or version<0:
                    raise SourceConflict('Invalid source version')
                store.conn.execute('INSERT INTO morrow_source_versions VALUES (?,?,?,?,?,?,?,?,?)',
                    (event['event_id'],instance,message,session,version,hashlib.sha256(payload['text'].encode()).hexdigest(),
                     state,raw_id,encode(event)))
            store.conn.execute('INSERT INTO morrow_source_receipts VALUES (?,?)', (event['event_id'],stamp))
            reply = source_protocol.record(store.conn, event)
        return reply

"""Pinned-Serein compatibility guards. No model rules or source text rewriting.

Install before creating the upstream Application. Epochs survive process death;
ContextVars bind asynchronous work to the epoch at which it read its inputs.
SQLite triggers check that epoch again under the actual write transaction.
"""
from contextlib import closing, contextmanager
from contextvars import ContextVar
from functools import wraps
from pathlib import Path
import json
import sqlite3

from source_protocol import SourceConflict

VERSION = 'morrow-source-guard-v1'
PINNED = 'ec9f99e8cbc5abf6c024e668760e5cf55884c3dd'
_epoch = ContextVar('morrow_source_epoch', default=None)
_maintenance = ContextVar('morrow_source_maintenance', default=None)
_author = ContextVar('morrow_source_author',default=None)
_installed = False


def identity(database):
    return str(Path(database).resolve())


def epoch(db):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='morrow_source_epoch'").fetchone():
        return 0
    row = db.execute('SELECT epoch FROM morrow_source_epoch WHERE id=1').fetchone()
    if row is None:
        raise SourceConflict('Source epoch unavailable')
    return row[0]


def current(database):
    with closing(sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro', uri=True)) as db:
        return epoch(db)


@contextmanager
def scope(database, expected=None, *, maintenance=False, authoring=False):
    key = identity(database)
    inherited=_epoch.get()
    if expected is None:
        expected=inherited[1] if inherited and inherited[0]==key else current(database)
    token = _epoch.set((key, expected))
    privileged = _maintenance.set(key) if maintenance else None
    author_token=_author.set(key) if authoring else None
    try:
        yield
    finally:
        if privileged is not None:
            _maintenance.reset(privileged)
        if author_token is not None:
            _author.reset(author_token)
        _epoch.reset(token)


def attach(db, database):
    key, opened_at = identity(database), epoch(db)
    def expected():
        inherited = _epoch.get()
        return inherited[1] if inherited and inherited[0] == key else opened_at
    db.create_function('morrow_operation_epoch', 0, expected)
    db.create_function('morrow_source_maintenance', 0, lambda: int(_maintenance.get() == key))
    db.create_function('morrow_host_authoring',0,lambda:int(_author.get()==key))


def batch_epoch(database, batch_id):
    with closing(sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro', uri=True)) as db:
        row = db.execute('SELECT epoch FROM morrow_batch_epochs WHERE batch_id=?', (batch_id,)).fetchone()
        if row is None:
            raise SourceConflict('Frozen batch has no trusted source epoch')
        if row[0] != epoch(db):
            raise SourceConflict('Frozen batch source epoch has been revoked')
        return row[0]


def initialize(db):
    """Additive, caller-owned transaction; never silently certify old batches."""
    statements = [
        'CREATE TABLE IF NOT EXISTS morrow_source_epoch(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL)',
        'INSERT OR IGNORE INTO morrow_source_epoch VALUES(1,0)',
        'CREATE TABLE IF NOT EXISTS morrow_batch_epochs(batch_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL)',
        'CREATE TABLE IF NOT EXISTS morrow_revoked_sources(source_key TEXT PRIMARY KEY,event_id TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS morrow_revoked_documents(id TEXT PRIMARY KEY,event_id TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS morrow_derived_vault(kind TEXT,id TEXT,event_id TEXT,payload TEXT,PRIMARY KEY(kind,id,event_id))',
        'CREATE TABLE IF NOT EXISTS morrow_document_dependencies(document_id TEXT,depends_on TEXT,PRIMARY KEY(document_id,depends_on))',
        'CREATE TABLE IF NOT EXISTS morrow_context_source_dependencies(context_id TEXT,source_key TEXT,PRIMARY KEY(context_id,source_key))',
        'CREATE TABLE IF NOT EXISTS morrow_host_context_receipts(operation TEXT PRIMARY KEY,context_hash TEXT,root_node TEXT,epoch INTEGER)',
    ]
    for sql in statements:
        db.execute(sql)
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    required = {'documents','revisions','sources','evidence_bindings','fact_events','fact_event_sources',
                'pipeline_batches','pipeline_jobs','raw_processing','pipeline_tracks','pipeline_routes'}
    if not required <= tables:
        raise SourceConflict('Pinned source guard requires initialized native pipeline tables')
    protected = required | {'pipeline_track_events','pipeline_event_details','pipeline_route_provenance',
                            'event_arc_links','narrative_materials','event_replacements'}
    for table in sorted(protected & tables):
        for action in ('INSERT','UPDATE','DELETE'):
            db.execute(f'''CREATE TRIGGER IF NOT EXISTS morrow_epoch_{table}_{action.lower()}
                BEFORE {action} ON {table}
                WHEN CASE WHEN (SELECT epoch FROM morrow_source_epoch WHERE id=1)>0
                     THEN morrow_operation_epoch()<>(SELECT epoch FROM morrow_source_epoch WHERE id=1)
                          AND morrow_source_maintenance()=0 ELSE 0 END
                BEGIN SELECT RAISE(ABORT,'revoked_source_epoch'); END''')
    db.execute('''CREATE TRIGGER IF NOT EXISTS morrow_capture_batch_epoch AFTER INSERT ON pipeline_batches
        BEGIN INSERT INTO morrow_batch_epochs VALUES(NEW.id,morrow_operation_epoch()); END''')
    # Once originals enter this instance, native model-authored unbound Scenes
    # must not bypass the host. Existing legacy Scenes remain readable; changes
    # need the trusted authoring route, not guessed retrospective provenance.
    for table,condition in [('documents',"NEW.kind='scene'"),
                            ('revisions',"EXISTS(SELECT 1 FROM documents WHERE id=NEW.document_id AND kind='scene')")]:
        db.execute(f'''CREATE TRIGGER IF NOT EXISTS morrow_require_scene_context_{table}
            BEFORE INSERT ON {table} WHEN {condition} AND EXISTS(SELECT 1 FROM morrow_source_versions)
              AND morrow_host_authoring()=0 AND morrow_source_maintenance()=0
            BEGIN SELECT RAISE(ABORT,'host_scene_context_required'); END''')
    for table,action,batch in [('pipeline_batches','UPDATE','NEW.id'),
                               ('pipeline_jobs','INSERT','NEW.batch_id'),('pipeline_jobs','UPDATE','NEW.batch_id'),
                               ('pipeline_route_provenance','INSERT','NEW.batch_id'),
                               ('pipeline_route_provenance','UPDATE','NEW.batch_id'),
                               ('raw_processing','INSERT','NEW.operation_id'),('raw_processing','UPDATE','NEW.operation_id')]:
        db.execute(f'''CREATE TRIGGER IF NOT EXISTS morrow_frozen_{table}_{action.lower()}
            BEFORE {action} ON {table} WHEN EXISTS(
              SELECT 1 FROM morrow_batch_epochs b WHERE b.batch_id={batch}
                AND b.epoch<>(SELECT epoch FROM morrow_source_epoch WHERE id=1))
              AND morrow_source_maintenance()=0
            BEGIN SELECT RAISE(ABORT,'revoked_frozen_batch'); END''')
    # An old service/CLI without the registered functions cannot accidentally
    # publish bridge-derived state after a withdrawal: its writes fail closed.
    for action in ('INSERT','UPDATE'):
        db.execute(f'''CREATE TRIGGER IF NOT EXISTS morrow_no_document_restore_{action.lower()}
            BEFORE {action} ON documents WHEN NEW.lifecycle<>'deleted'
            AND EXISTS(SELECT 1 FROM morrow_revoked_documents WHERE id=NEW.id)
            BEGIN SELECT RAISE(ABORT,'revoked_source_document'); END''')
        db.execute(f'''CREATE TRIGGER IF NOT EXISTS morrow_no_event_restore_{action.lower()}
            BEFORE {action} ON fact_events WHEN NEW.status<>'tombstoned'
            AND EXISTS(SELECT 1 FROM morrow_revoked_documents WHERE id=NEW.item_id)
            BEGIN SELECT RAISE(ABORT,'revoked_source_event'); END''')
        db.execute(f'''CREATE TRIGGER IF NOT EXISTS morrow_no_evidence_rebind_{action.lower()}
            BEFORE {action} ON evidence_bindings WHEN NEW.active=1 AND EXISTS(
              SELECT 1 FROM sources s JOIN morrow_revoked_sources r ON r.source_key=s.source_key WHERE s.id=NEW.source_id)
            BEGIN SELECT RAISE(ABORT,'revoked_source_evidence'); END''')
        db.execute(f'''CREATE TRIGGER IF NOT EXISTS morrow_check_event_source_{action.lower()}
            BEFORE {action} ON fact_event_sources WHEN NEW.source_system LIKE 'morrow:%' AND NOT EXISTS(
              SELECT 1 FROM morrow_source_current c JOIN raw_events r ON r.id=c.raw_id
              WHERE r.source=NEW.source_system AND r.session_id=NEW.session_id
                AND r.source_event_id=NEW.message_id AND r.text=NEW.content)
            BEGIN SELECT RAISE(ABORT,'unverified_event_source'); END''')


def invalidate(store, rows, event_id):
    """Revoke exact lineage, not semantic neighbours, inside source transaction."""
    from serein.core.store import encode, now
    db = store.conn
    keys = set()
    raw_ids = set()
    for row in rows:
        raw_ids.add(row['id'])
        keys.update((encode([row['source'],row['session_id'],row['source_event_id']]),
                     encode([row['source'],row['session_id'],str(row['id'])])))
    affected = set()
    for key in keys:
        affected.update(r[0] for r in db.execute('SELECT context_id FROM morrow_context_source_dependencies WHERE source_key=?',(key,)))
        db.execute('INSERT OR IGNORE INTO morrow_revoked_sources VALUES (?,?)', (key,event_id))
        affected.update(r[0] for r in db.execute('''SELECT b.document_id FROM evidence_bindings b
            JOIN sources s ON s.id=b.source_id WHERE s.source_key=?''', (key,)))
        source, session, message = json.loads(key)
        affected.update(r[0] for r in db.execute('''SELECT item_id FROM fact_event_sources
            WHERE source_system=? AND session_id=? AND message_id=?''', (source,session,message)))
    # Explicit dependencies, all revisions of a narrative, and replacement
    # descendants remain conservative dependencies even if bindings changed.
    pending = list(affected)
    while pending:
        key = pending.pop()
        children = set(r[0] for r in db.execute('SELECT document_id FROM narrative_materials WHERE target_id=?', (key,)))
        children.update(r[0] for r in db.execute('SELECT document_id FROM morrow_document_dependencies WHERE depends_on=?', (key,)))
        children.update(r[0] for r in db.execute('SELECT successor_id FROM event_replacements WHERE predecessor_id=?', (key,)))
        children.update(r[0] for r in db.execute('SELECT successor_id FROM fact_event_replacement_edges WHERE predecessor_id=?', (key,)))
        children.update(r[0] for r in db.execute('''SELECT DISTINCT d.id FROM documents d JOIN revisions r ON r.document_id=d.id
            WHERE d.kind='narrative' AND coalesce(json_extract(r.metadata_json,'$.legacy_registry.arc_key'),
            json_extract(r.metadata_json,'$.arc_key')) IN (SELECT arc_key FROM event_arc_links WHERE event_id=?)''',(key,)))
        for child in children - affected:
            affected.add(child); pending.append(child)
    for key in affected:
        db.execute('INSERT OR IGNORE INTO morrow_revoked_documents VALUES (?,?)', (key,event_id))
        fact = db.execute('SELECT * FROM fact_events WHERE item_id=?', (key,)).fetchone()
        if fact:
            db.execute('INSERT OR IGNORE INTO morrow_derived_vault VALUES (?,?,?,?)', ('fact_event',key,event_id,encode(dict(fact))))
            refs = [dict(r) for r in db.execute('SELECT * FROM fact_event_sources WHERE item_id=?', (key,))]
            db.execute('INSERT OR IGNORE INTO morrow_derived_vault VALUES (?,?,?,?)', ('fact_sources',key,event_id,encode(refs)))
            # Native shadow readers now see a tombstone; retained originals live
            # in the private vault. Reprojection cannot rebind obsolete evidence.
            db.execute("UPDATE fact_events SET status='tombstoned',recallable=0,updated_at=? WHERE item_id=?", (now(),key))
            db.execute('DELETE FROM fact_event_sources WHERE item_id=?', (key,))
        if store.read(key):
            store.set_lifecycle(key,'deleted')
            for binding in db.execute('SELECT id FROM evidence_bindings WHERE document_id=? AND active=1', (key,)).fetchall():
                store.unbind(binding[0],actor='morrow_source_withdrawal')
            db.execute('INSERT INTO index_outbox(document_id) VALUES (?)', (key,))
    # Frozen cards/routes are derived inputs too, not authoritative originals.
    tracks = set()
    for raw_id in raw_ids:
        route = db.execute('SELECT route_json FROM pipeline_routes WHERE raw_id=?', (raw_id,)).fetchone()
        if route:
            value=json.loads(route[0]); tracks.update([value.get('primary_track_id'),*(value.get('context_track_ids') or [])])
    tracks.discard(None)
    reroute = set(raw_ids)
    for row in db.execute('SELECT raw_id,route_json FROM pipeline_routes').fetchall():
        route=json.loads(row['route_json'])
        if tracks.intersection([route.get('primary_track_id'),*(route.get('context_track_ids') or [])]):
            reroute.add(row['raw_id'])
    for key in tracks:
        row=db.execute('SELECT * FROM pipeline_tracks WHERE id=?', (key,)).fetchone()
        if row:
            db.execute('INSERT OR IGNORE INTO morrow_derived_vault VALUES (?,?,?,?)', ('track',key,event_id,encode(dict(row))))
            db.execute('DELETE FROM pipeline_tracks WHERE id=?', (key,))
    for raw_id in reroute:
        db.execute('DELETE FROM pipeline_routes WHERE raw_id=?', (raw_id,))
        db.execute('DELETE FROM pipeline_route_provenance WHERE raw_id=?', (raw_id,))
        db.execute('DELETE FROM raw_processing WHERE raw_id=?', (raw_id,))
    db.execute('UPDATE morrow_source_epoch SET epoch=epoch+1 WHERE id=1')
    db.execute("UPDATE pipeline_batches SET status='superseded_source_epoch' WHERE status<>'done' AND status NOT LIKE 'superseded_%'")
    return len(affected)


def install_runtime():
    """Compatibility shim over the fixed classes; never edits upstream files."""
    global _installed
    if _installed:
        return
    from serein.core.store import Store
    from serein.compat.events import Events
    from serein.extensions import pipeline
    original_store = Store.__init__
    @wraps(original_store)
    def store_init(self, path, **kwargs):
        original_store(self,path,**kwargs); attach(self.conn,path)
    Store.__init__ = store_init
    original_connect = Events._connect
    @wraps(original_connect)
    def event_connect(self):
        db=original_connect(self); attach(db,self.db_path); return db
    Events._connect = event_connect
    original_advance = pipeline._advance
    @wraps(original_advance)
    async def advance(database, **kwargs):
        with scope(database):
            return await original_advance(database,**kwargs)
    pipeline._advance = advance
    original_job = pipeline.job
    @wraps(original_job)
    async def job(database,batch,*args,**kwargs):
        with scope(database,batch_epoch(database,batch['id'])):
            return await original_job(database,batch,*args,**kwargs)
    pipeline.job = job
    original_settle = Events.settle
    @wraps(original_settle)
    def settle(self,operation_id,*args,**kwargs):
        with closing(sqlite3.connect(Path(self.db_path).resolve().as_uri()+'?mode=ro',uri=True)) as db:
            guarded = db.execute("SELECT 1 FROM sqlite_master WHERE name='morrow_batch_epochs'").fetchone()
            batch = db.execute('SELECT epoch FROM morrow_batch_epochs WHERE batch_id=?',(operation_id,)).fetchone() if guarded else None
        expected = batch[0] if batch else None
        with scope(self.db_path,expected):
            return original_settle(self,operation_id,*args,**kwargs)
    Events.settle = settle
    # Tombstoned shadow rows are retained for audit, not returned as AI material.
    original_payload = Events._row_payload
    @wraps(original_payload)
    def payload(conn,row,**kwargs):
        if conn.execute("SELECT 1 FROM sqlite_master WHERE name='morrow_revoked_documents'").fetchone() and conn.execute(
                'SELECT 1 FROM morrow_revoked_documents WHERE id=?',(row['item_id'],)).fetchone():
            return {'item_id':row['item_id'],'item_type':row['item_type'],'status':'tombstoned',
                    'title':'','body':'','source_refs':[],'recallable':False}
        return original_payload(conn,row,**kwargs)
    Events._row_payload = staticmethod(payload)
    _installed = True

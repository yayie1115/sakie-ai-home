"""Versioned host context dependencies, opt-in and closed by default.

Only host code creates manifests. Unknown legacy/opaque inputs stay unknown;
model arguments and message metadata never grant publication authority.
Private rows contain identities and hashes, not copies of prompts or secrets.
"""
from contextlib import closing, contextmanager
from contextvars import ContextVar
from functools import wraps
import hashlib
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

VERSION = 'morrow-context-v1'
_scope = ContextVar('morrow_context',default=None)


def canonical(value):
    return json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def configured(db):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='morrow_context_control'").fetchone():return False
    row=db.execute('SELECT enabled FROM morrow_context_control WHERE id=1').fetchone()
    return bool(row and row[0])


def message_snapshot(row):
    value=dict(row)
    def decoded(name,default):
        raw=value.get(name)
        return json.loads(raw) if isinstance(raw,str) and raw else raw if raw is not None else default
    versions=decoded('versions',[]);active=value.get('active') or 0
    if type(active) is not int or active<0 or versions and active>=len(versions):raise ValueError('Invalid active version')
    return {**{key:value.get(key) for key in ('id','session_id','role','content','created_at','hidden','proactive')},
            'active':active,'attachments':decoded('attachments',[]),'tool_log':decoded('tool_log',[]),
            'version':versions[active] if versions else None}


def snapshot(db,kind,key):
    tables={'message':('messages','id'),'summary':('conversation_summaries','session_id'),
            'memory':('memory_entries','id'),'persona':('persona','id')}
    if kind not in tables:raise ValueError('Unsupported dependency kind')
    table,column=tables[kind]
    row=db.execute('SELECT * FROM '+table+' WHERE '+column+'=?',(key,)).fetchone()
    if row is None:return None
    if kind=='message':return message_snapshot(row)
    # Ignore telemetry/timestamps that do not change the rendered input.
    fields={'summary':('session_id','summary','covered_through_message_id','raw_overlap_count'),
            'memory':('id','content','kind','tags','pinned'),'persona':('id','content')}[kind]
    return {field:dict(row).get(field) for field in fields}


def valid_manifest(db,identifier,seen=None,*,allow_unknown=False):
    try:
        return _valid_manifest(db,identifier,seen,allow_unknown=allow_unknown)
    except (ValueError,KeyError,TypeError,sqlite3.Error,RecursionError):
        return False


def _valid_manifest(db,identifier,seen=None,*,allow_unknown=False):
    seen=set() if seen is None else seen
    if identifier in seen:return False
    seen=seen|{identifier}
    row=db.execute('SELECT * FROM morrow_context_manifests WHERE id=?',(identifier,)).fetchone()
    if row is None or row['state'] not in (('complete','unknown') if allow_unknown else ('complete',)):return False
    try:
        value=json.loads(row['payload'])
        if (digest(value)!=row['digest'] or value.get('version')!=VERSION
                or not isinstance(value.get('dependencies'),list)
                or not isinstance(value.get('unknown'),list)
                or value['unknown'] and not allow_unknown):return False
    except (ValueError,TypeError,AttributeError):return False
    for dep in value['dependencies']:
        try:actual=snapshot(db,dep['kind'],dep['key'])
        except (ValueError,TypeError,KeyError):return False
        if actual is None or digest(actual)!=dep['hash']:return False
        parent=dep.get('manifest')
        if parent and not valid_manifest(db,parent,seen,allow_unknown=allow_unknown):return False
    return True


def disposition(db,kind,key,actual_hash):
    row=db.execute('SELECT * FROM morrow_context_derivations WHERE kind=? AND object_key=? AND hash=?',
                   (kind,str(key),actual_hash)).fetchone()
    if row:
        if row['origin']=='owner':return 'independent'
        if valid_manifest(db,row['manifest']):return 'valid'
        if valid_manifest(db,row['manifest'],allow_unknown=True):
            actual=snapshot(db,kind,key)
            sid=actual.get('session_id') if actual else None
            if sid and db.execute('SELECT 1 FROM morrow_context_quarantine WHERE session_id=?',(sid,)).fetchone():return 'unknown_quarantined'
            return 'unknown'
        return 'revoked'
    # Never guess a legacy relationship. On an edit, unknown derived text in
    # that session (or unknown old memory globally) is quarantined for model use;
    # stored history and owner-visible records are retained.
    if kind in ('message','summary'):
        actual=snapshot(db,kind,key)
        sid=actual.get('session_id') if actual else None
        if sid and db.execute('SELECT 1 FROM morrow_context_quarantine WHERE session_id=?',(sid,)).fetchone():return 'unknown_quarantined'
    if kind=='memory' and db.execute('SELECT 1 FROM morrow_context_quarantine LIMIT 1').fetchone():return 'unknown_quarantined'
    return 'unknown'


def readable(db,kind,key):
    if not configured(db):return True
    actual=snapshot(db,kind,key)
    if actual is None:return False
    if kind=='message' and actual.get('hidden'):return False
    if kind=='message' and actual['role']=='user':return not actual.get('hidden')
    return disposition(db,kind,key,digest(actual)) not in ('revoked','unknown_quarantined')


class Trace:
    def __init__(self,path,session_id,purpose='chat'):
        self.path=str(Path(path).resolve());self.session_id=session_id;self.purpose=purpose
        self.dependencies={};self.unknown=set();self.identifier=None;self.last_digest=None
        self.inputs=[];self.preconditions={}

    def prior_summary(self,db,session_id):
        """Flatten proven leaves; never depend on the mutable output being replaced."""
        actual=snapshot(db,'summary',session_id)
        if actual is None:raise ValueError('Previous summary disappeared')
        stamp=digest(actual)
        self.preconditions[('summary',str(session_id))]=stamp
        self.inputs.append({'kind':'previous_summary','key':str(session_id),'hash':stamp})
        row=db.execute("SELECT manifest FROM morrow_context_derivations WHERE kind='summary' AND object_key=? AND hash=?",
                       (str(session_id),stamp)).fetchone()
        if not row or not valid_manifest(db,row[0],allow_unknown=True):
            self.opaque('previous_summary_without_verified_dependencies');return
        payload=json.loads(db.execute('SELECT payload FROM morrow_context_manifests WHERE id=?',(row[0],)).fetchone()[0])
        self.unknown.update(payload['unknown'])
        for dep in payload['dependencies']:
            self.dependencies[(dep['kind'],dep['key'])]=dep

    def opaque(self,reason):
        self.unknown.add(reason)

    def record(self,db,kind,key,expected=None):
        actual=snapshot(db,kind,key)
        if actual is None:
            self.opaque('missing_'+kind);return
        if expected and any(actual.get(k)!=v for k,v in expected.items()):
            self.opaque('changed_during_'+kind+'_read');return
        stamp=digest(actual);parent=None;status='independent' if kind=='persona' else 'unknown'
        if kind=='message' and actual['role']=='user':status='primary'
        elif kind!='persona':
            status=disposition(db,kind,key,stamp)
            row=db.execute('SELECT manifest FROM morrow_context_derivations WHERE kind=? AND object_key=? AND hash=?',
                           (kind,str(key),stamp)).fetchone()
            parent=row[0] if row and status=='valid' else None
        if status not in ('primary','independent','valid'):self.opaque(status+'_'+kind)
        dep={'kind':kind,'key':str(key),'hash':stamp,'manifest':parent,'status':status}
        if kind=='message':
            event=db.execute("SELECT event_id,payload,kind FROM memory_bridge_outbox WHERE message_id=? ORDER BY sequence DESC LIMIT 1",(key,)).fetchone() if db.execute("SELECT 1 FROM sqlite_master WHERE name='memory_bridge_outbox'").fetchone() else None
            if event and event['kind']=='upsert':
                payload=json.loads(event['payload'])
                if payload.get('text')==actual['content'] and payload.get('active')==actual['active']:
                    dep['source_event_id']=event['event_id']
            dep.update(session_id=actual['session_id'],version=actual['active'])
        self.dependencies[(kind,str(key))]=dep

    def seal(self):
        value={'version':VERSION,'session_id':self.session_id,'purpose':self.purpose,
               'dependencies':sorted(self.dependencies.values(),key=lambda d:(d['kind'],d['key'])),
               'unknown':sorted(self.unknown),'inputs':self.inputs}
        stamp=digest(value)
        if self.last_digest==stamp:return self.identifier
        with closing(connect(self.path)) as db,db:
            if not configured(db):return None
            identifier=uuid4().hex
            state='complete' if not value['unknown'] else 'unknown'
            db.execute('INSERT INTO morrow_context_manifests VALUES (?,?,?,?,?,?)',
                       (identifier,self.session_id,self.purpose,state,stamp,canonical(value)))
            db.executemany('INSERT INTO morrow_context_dependencies VALUES (?,?,?)',
                           [(identifier,d['kind'],d['key']) for d in value['dependencies']])
        self.identifier,self.last_digest=identifier,stamp
        return identifier

    def publication_current(self,db):
        return bool(self.identifier and valid_manifest(db,self.identifier,allow_unknown=True)
                    and all((value:=snapshot(db,kind,key)) is not None and digest(value)==stamp
                            for (kind,key),stamp in self.preconditions.items()))


def active():
    current=_scope.get()
    return current.get('trace') if current else None


@contextmanager
def generation(path,session_id,purpose='chat'):
    old=_scope.get();state={'path':str(Path(path).resolve()),'trace':None,'owner':False}
    token=_scope.set(state)
    try:
        with closing(connect(path)) as db:
            if configured(db):state['trace']=Trace(path,session_id,purpose)
        yield state['trace']
    finally:_scope.reset(token)


@contextmanager
def owner():
    token=_scope.set({'owner':True,'trace':None})
    try:yield
    finally:_scope.reset(token)


def owner_operation(fn):
    @wraps(fn)
    def wrapped(*args,**kwargs):
        with owner():return fn(*args,**kwargs)
    return wrapped


def record(db,kind,key,expected=None):
    trace=active()
    if trace:trace.record(db,kind,key,expected)


def record_message(db,row):
    trace=active()
    if not trace:return
    selected=message_snapshot(row)
    trace.record(db,'message',row['id'],{key:selected[key] for key in
                 ('role','content','created_at','active','attachments','tool_log','version')})
    if selected['attachments']:trace.opaque('media_without_complete_dependency_manifest')
    if selected['tool_log']:
        actual=snapshot(db,'message',row['id'])
        if disposition(db,'message',row['id'],digest(actual))!='valid':
            trace.opaque('legacy_tool_result_without_manifest')


def legacy_recall_blocked(path):
    with closing(connect(path)) as db:
        return configured(db) and bool(db.execute('SELECT 1 FROM morrow_context_quarantine LIMIT 1').fetchone())


def opaque(reason):
    trace=active()
    if trace:trace.opaque(reason)


def observe(events):
    trace=active()
    if trace:trace.seal()
    for kind,payload in events:
        if trace and kind=='tool_result':
            trace.opaque('tool_result_without_verified_dependency_manifest')
            trace.seal()
        yield kind,payload
    if trace:trace.seal()


def operation_scope(path_getter,purpose):
    def decorate(fn):
        @wraps(fn)
        def wrapped(db,session_id,*args,**kwargs):
            attach(db)
            with generation(path_getter(),session_id,purpose):return fn(db,session_id,*args,**kwargs)
        return wrapped
    return decorate


def stream_scope(path_getter):
    """Keep generation authority through the caller's final persistence."""
    def decorate(fn):
        @wraps(fn)
        def wrapped(session_id,*args,**kwargs):
            current=_scope.get()
            if current and current.get('path')==str(Path(path_getter()).resolve()):
                yield from fn(session_id,*args,**kwargs)
            else:
                with generation(path_getter(),session_id):yield from fn(session_id,*args,**kwargs)
        return wrapped
    return decorate


def attach(db):
    db.row_factory=sqlite3.Row
    path=db.execute('PRAGMA database_list').fetchone()[2]
    def trace():
        value=_scope.get()
        return value.get('trace') if value and value.get('path')==str(Path(path).resolve()) else None
    def authorized():
        state=_scope.get()
        if state and state.get('owner'):return 1
        value=trace()
        return int(bool(value and value.identifier and valid_manifest(db,value.identifier)))
    db.create_function('morrow_context_authorized',0,authorized)
    db.create_function('morrow_context_id',0,lambda:trace().identifier if trace() else None)
    db.create_function('morrow_context_owner',0,lambda:int(bool(_scope.get() and _scope.get().get('owner'))))
    db.create_function('morrow_context_current',0,lambda:int(bool(trace() and trace().publication_current(db))))
    db.create_function('morrow_context_hash',1,lambda raw:digest(json.loads(raw)))
    db.create_function('morrow_message_hash',1,lambda raw:digest(message_snapshot(json.loads(raw))))
    return db


def connect(path,*args,**kwargs):
    return attach(sqlite3.connect(path,*args,**kwargs))


def initialize(db):
    """Explicit isolated upgrade; disabled by default, no implicit commit first."""
    attach(db)
    for statement in '''
        CREATE TABLE IF NOT EXISTS morrow_context_control(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)));
        INSERT OR IGNORE INTO morrow_context_control VALUES(1,0);
        CREATE TABLE IF NOT EXISTS morrow_context_manifests(id TEXT PRIMARY KEY,session_id INTEGER,purpose TEXT,state TEXT,digest TEXT,payload TEXT);
        CREATE TABLE IF NOT EXISTS morrow_context_dependencies(manifest TEXT,kind TEXT,object_key TEXT,PRIMARY KEY(manifest,kind,object_key));
        CREATE TABLE IF NOT EXISTS morrow_context_derivations(kind TEXT,object_key TEXT,hash TEXT,manifest TEXT,origin TEXT,PRIMARY KEY(kind,object_key,hash));
        CREATE TABLE IF NOT EXISTS morrow_context_quarantine(session_id INTEGER PRIMARY KEY);
        CREATE INDEX IF NOT EXISTS morrow_context_dependency_lookup ON morrow_context_dependencies(kind,object_key);
    '''.split(';'):
        if statement.strip():db.execute(statement)
    tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    # Quarantine is metadata, not deletion of a user's memories or old versions.
    for table,kind,key,sid in [('messages','message','OLD.id','OLD.session_id'),
                               ('memory_entries','memory','OLD.id','NULL'),
                               ('conversation_summaries','summary','OLD.session_id','OLD.session_id')]:
        if table not in tables:continue
        for action in ('UPDATE','DELETE'):
            changed=''
            if action=='UPDATE':
                cols={'messages':['content','active','versions','attachments','tool_log','hidden','created_at','session_id','role'],
                      'memory_entries':['content','kind','tags','pinned'],
                      'conversation_summaries':['summary','covered_through_message_id','raw_overlap_count']}[table]
                present={r[1] for r in db.execute('PRAGMA table_info('+table+')')}
                changed=' AND ('+' OR '.join('NEW.'+c+' IS NOT OLD.'+c for c in cols if c in present)+')'
            quarantine=(f'''INSERT OR IGNORE INTO morrow_context_quarantine SELECT {sid} WHERE {sid} IS NOT NULL
                AND (morrow_context_id() IS NULL OR EXISTS(SELECT 1 FROM morrow_context_dependencies
                     WHERE manifest=morrow_context_id() AND kind='message' AND object_key=CAST(OLD.id AS TEXT)));''') if table=='messages' else ''
            db.execute(f'''CREATE TRIGGER IF NOT EXISTS morrow_context_invalidate_{table}_{action.lower()}
                AFTER {action} ON {table} WHEN (SELECT enabled FROM morrow_context_control WHERE id=1)=1{changed}
                BEGIN UPDATE morrow_context_manifests SET state='revoked' WHERE id IN
                  (SELECT manifest FROM morrow_context_dependencies WHERE kind='{kind}' AND object_key=CAST({key} AS TEXT));
                  {quarantine} END''')
    if 'sessions' in tables:
        db.execute('''CREATE TRIGGER IF NOT EXISTS morrow_context_session_delete AFTER DELETE ON sessions
            WHEN (SELECT enabled FROM morrow_context_control WHERE id=1)=1
            BEGIN UPDATE morrow_context_manifests SET state='revoked' WHERE session_id=OLD.id;
            INSERT OR IGNORE INTO morrow_context_quarantine VALUES(OLD.id); END''')
    if 'messages' in tables:
        fields={r[1] for r in db.execute('PRAGMA table_info(messages)')}
        chosen=[k for k in ('id','session_id','role','content','created_at','hidden','proactive','active','attachments','tool_log','versions') if k in fields]
        row_json='json_object('+','.join("'"+k+"',NEW."+k for k in chosen)+')'
        for action in ('INSERT','UPDATE'):
            db.execute(f'''CREATE TRIGGER IF NOT EXISTS morrow_context_message_link_{action.lower()}
                AFTER {action} ON messages WHEN (SELECT enabled FROM morrow_context_control WHERE id=1)=1
                  AND NEW.role='assistant' AND morrow_context_id() IS NOT NULL
                BEGIN INSERT OR REPLACE INTO morrow_context_derivations VALUES('message',CAST(NEW.id AS TEXT),
                  morrow_message_hash({row_json}),morrow_context_id(),'derived'); END''')
    if 'conversation_summaries' in tables:
        for action in ('INSERT','UPDATE'):
            db.execute(f'''CREATE TRIGGER IF NOT EXISTS morrow_context_summary_guard_{action.lower()}
                BEFORE {action} ON conversation_summaries WHEN (SELECT enabled FROM morrow_context_control WHERE id=1)=1
                  AND morrow_context_owner()=0 AND morrow_context_current()=0
                BEGIN SELECT RAISE(ABORT,'summary_context_unverified'); END''')
    # Every memory-table writer, including an unsupported CLI, is mediated at
    # the database boundary. Registered unknown/background writers fail closed.
    if 'memory_entries' in tables:
        for action in ('INSERT','UPDATE','DELETE'):
            db.execute(f'''CREATE TRIGGER IF NOT EXISTS morrow_context_memory_guard_{action.lower()}
                BEFORE {action} ON memory_entries WHEN (SELECT enabled FROM morrow_context_control WHERE id=1)=1
                  AND morrow_context_owner()=0
                BEGIN SELECT RAISE(ABORT,'memory_context_unverified'); END''')
        for action in ('INSERT','UPDATE'):
            # SQL and Python use exactly the same semantic projection.
            db.execute(f'''CREATE TRIGGER IF NOT EXISTS morrow_context_memory_link_{action.lower()}
                AFTER {action} ON memory_entries WHEN (SELECT enabled FROM morrow_context_control WHERE id=1)=1
                BEGIN INSERT OR REPLACE INTO morrow_context_derivations VALUES('memory',CAST(NEW.id AS TEXT),
                  morrow_context_hash(json_object('id',NEW.id,'content',NEW.content,'kind',NEW.kind,'tags',NEW.tags,'pinned',NEW.pinned)),
                  morrow_context_id(),CASE WHEN morrow_context_owner()=1 THEN 'owner' ELSE 'derived' END); END''')
    db.commit()


def bind(db,kind,key,trace=None):
    """Call inside output transaction. Stale replies may remain history, never evidence."""
    if not configured(db):return
    value=trace or active();actual=snapshot(db,kind,key)
    if value is None or actual is None:return
    identifier=value.identifier
    if not identifier:return
    db.execute('INSERT OR REPLACE INTO morrow_context_derivations VALUES (?,?,?,?,?)',
               (kind,str(key),digest(actual),identifier,'derived'))

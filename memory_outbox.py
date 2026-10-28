"""Transactional host capture, disabled until external withdrawal is certified.

Triggers cover all existing message mutation paths without duplicating those
paths. They share the application's transaction, so rollback also rolls back
events. There is no historical scan/backfill on installation.
"""
import json
import hashlib
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path
from uuid import uuid4


def initialize(db):
    db.executescript('''
        CREATE TABLE IF NOT EXISTS memory_bridge_control(
            id INTEGER PRIMARY KEY CHECK(id=1), instance_id TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0, start_after_id INTEGER NOT NULL DEFAULT 0,
            recall_blocked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS memory_bridge_outbox(
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
            kind TEXT NOT NULL, message_id INTEGER, session_id INTEGER NOT NULL,
            payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0);
    ''')
    db.execute('INSERT OR IGNORE INTO memory_bridge_control(id,instance_id) VALUES (1,?)', (uuid4().hex,))
    db.commit()
    control = '(SELECT enabled FROM memory_bridge_control WHERE id=1)=1'
    for action, row in [('INSERT', 'NEW'), ('UPDATE', 'NEW'), ('DELETE', 'OLD')]:
        relevant = f"{row}.role IN ('user','assistant') AND {row}.id>(SELECT start_after_id FROM memory_bridge_control WHERE id=1)"
        if action == 'UPDATE':
            relevant += ' AND (NEW.content IS NOT OLD.content OR NEW.active IS NOT OLD.active OR NEW.versions IS NOT OLD.versions OR NEW.hidden IS NOT OLD.hidden OR NEW.attachments IS NOT OLD.attachments)'
        kind = "'withdraw'" if action == 'DELETE' else f"CASE WHEN {row}.hidden<>0 THEN 'withdraw' ELSE 'upsert' END"
        snapshot = f"json_object('role',{row}.role,'text',{row}.content,'created_at',{row}.created_at,'active',{row}.active,'hidden',{row}.hidden,'partial',coalesce(json_extract({row}.versions,'$['||{row}.active||'].partial'),0))"
        quarantine = '' if action == 'INSERT' else 'UPDATE memory_bridge_control SET recall_blocked=1 WHERE id=1;'
        db.executescript(f'''
            CREATE TRIGGER IF NOT EXISTS memory_bridge_message_{action.lower()}
            AFTER {action} ON messages WHEN {control} AND {relevant}
            BEGIN
                INSERT INTO memory_bridge_outbox(event_id,kind,message_id,session_id,payload)
                VALUES(lower(hex(randomblob(16))),{kind},{row}.id,{row}.session_id,{snapshot});
                {quarantine}
            END;
        ''')
    db.executescript(f'''
        CREATE TRIGGER IF NOT EXISTS memory_bridge_session_delete AFTER DELETE ON sessions
        WHEN {control}
        BEGIN
            INSERT INTO memory_bridge_outbox(event_id,kind,message_id,session_id,payload)
            VALUES(lower(hex(randomblob(16))),'withdraw_session',NULL,OLD.id,'{{}}');
            UPDATE memory_bridge_control SET recall_blocked=1 WHERE id=1;
        END;
    ''')


@contextmanager
def delivery_lock(db_path):
    """Process-lifetime lock: no expiring lease can leave two live senders.

    Never unlink the lock inode. Kernel release on crash allows recovery without
    holding a SQLite write transaction across an HTTP request.
    """
    path = str(Path(db_path).resolve(strict=True)) + '.source-worker.lock'
    with open(path, 'a+b') as handle:
        acquired = False
        try:
            if __import__('os').name == 'nt':
                import msvcrt
                if handle.seek(0, 2) == 0:
                    handle.write(b'\0'); handle.flush()
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    acquired = True
                except OSError:
                    pass
            else:
                import fcntl
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                except BlockingIOError:
                    pass
            yield acquired
        finally:
            if acquired:
                if __import__('os').name == 'nt':
                    handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def drain(db_path, send, *, inspect=None, limit=25):
    import serein_bridge
    if not serein_bridge.SOURCE_RETRACTION_VERIFIED:
        return {'status': 'disabled_unverified_withdrawal', 'acknowledged': 0}
    if inspect is None:
        return {'status': 'disabled_missing_cursor_handshake', 'acknowledged': 0}
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError('Source batch limit must be between 1 and 100')
    with delivery_lock(db_path) as acquired:
        if not acquired:
            return {'status': 'worker_busy', 'acknowledged': 0}
        return _drain_locked(db_path, send, inspect, limit)


def _drain_locked(db_path, send, inspect, limit):
    from source_protocol import PROTOCOL, GENESIS, SourceConflict, envelope, fingerprint, acknowledgement
    with closing(sqlite3.connect(db_path)) as db:
        db.row_factory = sqlite3.Row
        state = db.execute('SELECT * FROM memory_bridge_control WHERE id=1').fetchone()
        if not state or not state['enabled']:
            return {'status': 'disabled', 'acknowledged': 0}
        try:
            remote = inspect(state['instance_id'])
        except SourceConflict:
            return {'status': 'cursor_conflict', 'acknowledged': 0}
        except Exception:
            return {'status': 'retry_pending', 'acknowledged': 0}
        if (not isinstance(remote, dict) or remote.get('protocol') != PROTOCOL
                or remote.get('instance_id') != state['instance_id']
                or type(remote.get('sequence')) is not int or remote['sequence'] < 0):
            return {'status': 'cursor_conflict', 'acknowledged': 0}
        # Walk retained history, not just pending rows. This detects restoring
        # either side, including an old local snapshot whose ACKs are ahead of
        # a restored receiver, or a divergent suffix reusing old sequence IDs.
        previous_sequence, previous_hash = 0, GENESIS
        chain = []
        for row in db.execute('SELECT * FROM memory_bridge_outbox ORDER BY sequence'):
            event = envelope({'event_id': row['event_id'], 'kind': row['kind'], 'instance_id': state['instance_id'],
                'message_id': row['message_id'], 'session_id': row['session_id'], 'message': json.loads(row['payload'])},
                row['sequence'], previous_sequence, previous_hash)
            previous_sequence, previous_hash = row['sequence'], fingerprint(event)
            if row['sequence'] <= remote['sequence']:
                if row['sequence'] == remote['sequence']:
                    break
            else:
                chain.append((row, event))
                break
        # The first unsent row does not form part of the remote prefix.
        if chain:
            row, event = chain[0]
            prefix = (event['previous_sequence'], event['previous_hash'])
        else:
            prefix = (previous_sequence, previous_hash)
        if prefix != (remote['sequence'], remote.get('hash')):
            return {'status': 'cursor_conflict', 'acknowledged': 0}
        cursor_sequence, cursor_hash = remote['sequence'], remote['hash']
        acknowledged = db.execute("UPDATE memory_bridge_outbox SET state='acknowledged' WHERE sequence<=? AND state!='acknowledged'",
                                  (cursor_sequence,)).rowcount
        db.commit()
        rows = db.execute('SELECT * FROM memory_bridge_outbox WHERE sequence>? ORDER BY sequence LIMIT ?',
                          (cursor_sequence, limit)).fetchall()
        for row in rows:
            event = envelope({'event_id': row['event_id'], 'kind': row['kind'], 'instance_id': state['instance_id'],
                'message_id': row['message_id'], 'session_id': row['session_id'], 'message': json.loads(row['payload'])},
                row['sequence'], cursor_sequence, cursor_hash)
            db.execute("UPDATE memory_bridge_outbox SET state='inflight',attempts=attempts+1 WHERE sequence=?", (row['sequence'],)); db.commit()
            try:
                result = send(event)
                if result != acknowledgement(event):
                    raise ValueError('No durable matching acknowledgement')
            except SourceConflict:
                return {'status': 'cursor_conflict', 'acknowledged': acknowledged}
            except Exception:
                return {'status': 'retry_pending', 'acknowledged': acknowledged}
            db.execute("UPDATE memory_bridge_outbox SET state='acknowledged' WHERE sequence=?", (row['sequence'],)); db.commit()
            cursor_sequence, cursor_hash = row['sequence'], fingerprint(event)
            acknowledged += 1
        # Never clear quarantine automatically: downstream frozen jobs and unbound
        # Scenes still require a verified epoch barrier, not just empty outbox.
        return {'status': 'processed_quarantine_retained', 'acknowledged': acknowledged}


def quarantine(db_path):
    try:
        with closing(sqlite3.connect('file:' + str(db_path) + '?mode=ro', uri=True)) as db:
            row = db.execute('SELECT enabled,recall_blocked FROM memory_bridge_control WHERE id=1').fetchone()
            return bool(row and row[0] and row[1])
    except sqlite3.Error:
        return True  # Unknown state cannot authorize external memory access.


def source_context(db_path, session_id, records, epoch, *, trace=None):
    """Resolve the EXACT host history snapshot, never model-authored evidence.

    `records` must come from get_history's original SQLite rows before model
    generation, not a later reread or tool arguments. Missing coverage fails
    closed; this function cannot reconstruct summary/tool-result provenance.
    """
    if type(epoch) is not int or epoch<0 or not isinstance(records,list) or not 1<=len(records)<=200:
        return None
    if trace is not None:
        try:
            import context_binding
            graph=context_binding.export(db_path,trace,epoch)
            if graph is None or graph['session_id']!=session_id:return None
            objects={(o['kind'],o['key']):o for o in graph['objects']}
            for record in records:
                obj=objects.get(('message',str(record['id'])))
                if not obj or obj['snapshot']['content']!=record['content'] or obj['snapshot']['active']!=record['active']:return None
            return {'instance_id':graph['instance_id'],'session_id':session_id,'sources':[],
                    'epoch':epoch,'context_graph':graph}
        except (ValueError,KeyError,TypeError,sqlite3.Error):return None
    try:
        with closing(sqlite3.connect(Path(db_path).resolve().as_uri()+'?mode=ro',uri=True)) as db:
            db.row_factory=sqlite3.Row;db.execute('BEGIN')
            control=db.execute('SELECT * FROM memory_bridge_control WHERE id=1').fetchone()
            if not control or not control['enabled'] or control['recall_blocked']:
                return None
            refs=[];seen=set()
            for record in records:
                if not isinstance(record,dict) or record.get('id') in seen:return None
                seen.add(record.get('id'))
                refs.append(resolve_source(db,session_id,record))
            return {'instance_id':control['instance_id'],'session_id':session_id,'sources':refs,'epoch':epoch}
    except (sqlite3.Error,ValueError,KeyError,TypeError):
        return None


def source_instance(db_path):
    try:
        with closing(sqlite3.connect(Path(db_path).resolve().as_uri()+'?mode=ro',uri=True)) as db:
            row=db.execute('SELECT instance_id,enabled,recall_blocked FROM memory_bridge_control WHERE id=1').fetchone()
            return row[0] if row and row[1] and not row[2] else None
    except (sqlite3.Error,OSError):
        return None


def resolve_source(db,session_id,record):
    """Resolve a host row using the caller's existing snapshot transaction."""
    if (not isinstance(record,dict) or type(record.get('id')) is not int
            or type(record.get('active')) is not int or not isinstance(record.get('content'),str)):
        raise ValueError('Host source not current and acknowledged')
    key=record['id']
    current=db.execute('SELECT content,active,hidden,role FROM messages WHERE id=? AND session_id=?',
                       (key,session_id)).fetchone()
    event=db.execute('SELECT * FROM memory_bridge_outbox WHERE message_id=? AND session_id=? ORDER BY sequence DESC LIMIT 1',
                     (key,session_id)).fetchone()
    if not current or current['hidden'] or not event or event['kind']!='upsert' or event['state']!='acknowledged':
        raise ValueError('Host source not current and acknowledged')
    payload=json.loads(event['payload'])
    if (payload.get('partial') or payload.get('hidden') or current['role'] not in ('user','assistant')
            or current['content']!=record['content'] or current['active']!=record['active']
            or payload['text']!=record['content'] or payload['active']!=record['active']):
        raise ValueError('Host source not current and acknowledged')
    return {'message_id':key,'event_id':event['event_id'],'version':record['active'],
            'content_hash':hashlib.sha256(record['content'].encode()).hexdigest()}

"""Transactional host capture, disabled until external withdrawal is certified.

Triggers cover all existing message mutation paths without duplicating those
paths. They share the application's transaction, so rollback also rolls back
events. There is no historical scan/backfill on installation.
"""
import json
import sqlite3
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


def drain(db_path, send, *, limit=25):
    import serein_bridge
    if not serein_bridge.SOURCE_RETRACTION_VERIFIED:
        return {'status': 'disabled_unverified_withdrawal', 'acknowledged': 0}
    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        state = db.execute('SELECT * FROM memory_bridge_control WHERE id=1').fetchone()
        if not state or not state['enabled']:
            return {'status': 'disabled', 'acknowledged': 0}
        acknowledged = 0
        rows = db.execute("SELECT * FROM memory_bridge_outbox WHERE state!='acknowledged' ORDER BY sequence LIMIT ?", (limit,)).fetchall()
        for row in rows:
            db.execute("UPDATE memory_bridge_outbox SET state='inflight',attempts=attempts+1 WHERE sequence=?", (row['sequence'],)); db.commit()
            payload = json.loads(row['payload'])
            event = {'event_id': row['event_id'], 'kind': row['kind'], 'instance_id': state['instance_id'],
                     'message_id': row['message_id'], 'session_id': row['session_id'], 'message': payload}
            try:
                result = send(event)
                if result.get('event_id') != row['event_id'] or result.get('state') != 'applied':
                    raise ValueError('No durable matching acknowledgement')
            except Exception:
                return {'status': 'retry_pending', 'acknowledged': acknowledged}
            db.execute("UPDATE memory_bridge_outbox SET state='acknowledged' WHERE sequence=?", (row['sequence'],)); db.commit()
            acknowledged += 1
        # Never clear quarantine automatically: downstream frozen jobs and unbound
        # Scenes still require a verified epoch barrier, not just empty outbox.
        return {'status': 'processed_quarantine_retained', 'acknowledged': acknowledged}


def quarantine(db_path):
    try:
        with sqlite3.connect('file:' + str(db_path) + '?mode=ro', uri=True) as db:
            row = db.execute('SELECT enabled,recall_blocked FROM memory_bridge_control WHERE id=1').fetchone()
            return bool(row and row[0] and row[1])
    except sqlite3.Error:
        return True  # Unknown state cannot authorize external memory access.

"""Optional, fail-open Serein adapter. No implicit credentials or data export.

Raw synchronization remains capability-gated: this pinned upstream has no
verified retract/version protocol. Changing a boolean cannot bypass that gate.
"""
import hashlib
import json
import logging
import os
from pathlib import Path
import sqlite3
import threading
import time
from urllib.parse import urlsplit

import requests

LOG = logging.getLogger(__name__)
SOURCE_RETRACTION_VERIFIED = False
ALLOWED_TOOLS = {"read_memory", "recall_memory", "write_scene", "edit_scene", "set_scene_status"}
WRITES = {"write_scene", "edit_scene", "set_scene_status"}
LEGACY_TOOLS = {"write_memory", "update_memory", "delete_memory", "add_dynamic_memory",
                "update_dynamic_memory", "delete_dynamic_memory"}
_lock = threading.Lock()
_client = None
_signature = None


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class Conflict(ValueError):
    pass


class Ledger:
    """Separate private durable state, never added to the host's schema."""
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS deliveries(
                    id INTEGER PRIMARY KEY, receipt TEXT UNIQUE NOT NULL,
                    window TEXT NOT NULL, ids TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS operations(
                    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                    state TEXT NOT NULL, result TEXT);
                CREATE TABLE IF NOT EXISTS raw_outbox(
                    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                    payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0);
            """)
        os.chmod(path, 0o600)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    def recent(self, window):
        with self.connect() as db:
            rows = db.execute('SELECT ids FROM deliveries WHERE window=? ORDER BY id DESC LIMIT 5',
                              (window,)).fetchall()
        return list(dict.fromkeys(item for row in rows for item in json.loads(row['ids'])))

    def delivered(self, receipt, window, ids):
        value = canonical(ids)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT window,ids FROM deliveries WHERE receipt=?', (receipt,)).fetchone()
            if old and (old['window'] != window or old['ids'] != value):
                raise Conflict('Delivery acknowledgement conflicts')
            db.execute('INSERT OR IGNORE INTO deliveries(receipt,window,ids) VALUES (?,?,?)',
                       (receipt, window, value))

    def begin(self, identifier, fingerprint):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT * FROM operations WHERE id=?', (identifier,)).fetchone()
            if old:
                if old['fingerprint'] != fingerprint:
                    raise Conflict('Operation identity conflicts')
                if old['state'] == 'succeeded':
                    return json.loads(old['result'])
                raise Conflict('Operation outcome unknown; inspect before retrying')
            # Block another turn from blindly repeating an unresolved write.
            if db.execute("SELECT 1 FROM operations WHERE fingerprint=? AND state='unknown'",
                          (fingerprint,)).fetchone():
                raise Conflict('An identical write has an unknown outcome')
            db.execute("INSERT INTO operations VALUES (?,?,'unknown',NULL)", (identifier, fingerprint))

    def complete(self, identifier, result):
        with self.connect() as db:
            db.execute("UPDATE operations SET state='succeeded',result=? WHERE id=?", (canonical(result), identifier))

    def enqueue(self, identifier, payload):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            stamp = digest(payload)
            old = db.execute('SELECT fingerprint FROM raw_outbox WHERE id=?', (identifier,)).fetchone()
            if old and old['fingerprint'] != stamp:
                raise Conflict('Same message identity has different content')
            db.execute('INSERT OR IGNORE INTO raw_outbox(id,fingerprint,payload) VALUES (?,?,?)',
                       (identifier, stamp, canonical(payload)))

    def flush(self, sender, *, retraction_verified=False):
        if not SOURCE_RETRACTION_VERIFIED or not retraction_verified:
            raise Conflict('Raw synchronization disabled: source retraction is not verified')
        # In-flight rows are intentionally retried only through a verifying sender.
        with self.connect() as db:
            rows = db.execute("SELECT * FROM raw_outbox WHERE state IN ('pending','inflight') ORDER BY rowid LIMIT 25").fetchall()
        acknowledged = 0
        for row in rows:
            with self.connect() as db:
                db.execute("UPDATE raw_outbox SET state='inflight',attempts=attempts+1 WHERE id=?", (row['id'],))
            try:
                sender(json.loads(row['payload']))
            except Conflict:
                with self.connect() as db:
                    db.execute("UPDATE raw_outbox SET state='conflict' WHERE id=?", (row['id'],))
                raise
            except Exception:
                # Preserve row and order. Retrying must check the remote content first.
                return acknowledged
            with self.connect() as db:
                db.execute("UPDATE raw_outbox SET state='acknowledged' WHERE id=?", (row['id'],))
            acknowledged += 1
        return acknowledged


class Bridge:
    def __init__(self, config, transport=None, mcp=None):
        self.config = config
        url = urlsplit(config['base_url'])
        if (url.scheme != 'http' or url.hostname not in ('127.0.0.1', '::1', 'localhost')
                or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment):
            raise ValueError('Serein must use an explicit loopback HTTP origin')
        self.base = config['base_url'].rstrip('/')
        self.token = Path(config['token_file']).read_text(encoding='utf-8').strip()
        if not self.token:
            raise ValueError('Empty Serein credential')
        self.ledger = Ledger(config['ledger'])
        self.transport = transport or requests.Session()
        self.transport.trust_env = False
        if mcp is None:
            import mcp_client
            mcp = mcp_client
        self.mcp = mcp
        self._definitions = None
        self._discovered_at = 0
        self._retry_after = 0

    def archive_event(self, event):
        """Verifying append transport for synthetic tests/future gated worker only.

        Not exposed as an AI tool and never called by the production chat path.
        Lookup before AND after ingest closes lost-ACK duplicate/conflict cases.
        This does not provide withdrawal of an already archived source.
        """
        required = ('source', 'source_event_id', 'session_id', 'role', 'text', 'created_at')
        if any(not isinstance(event.get(key), str) or not event[key] for key in required):
            raise ValueError('Explicit source, version identity, role, text and timestamp required')
        if event['role'] not in ('user', 'assistant'):
            raise ValueError('Only original dialogue can be archived')
        from datetime import datetime

        def request(path, body):
            response = self.transport.post(self.base + path,
                headers={'Authorization': 'Bearer ' + self.token}, json=body,
                timeout=(.5, 4), allow_redirects=False)
            response.raise_for_status()
            if response.status_code != 200:
                raise ValueError('Unexpected archive response')
            return response.json()

        def existing():
            result = request('/v1/host/messages/search', {'query': '#' + event['source_event_id'],
                'session_id': event['session_id'], 'limit': 100})
            if not isinstance(result.get('items'), list) or result.get('has_more'):
                raise Conflict('Cannot prove archive identity')
            rows = [row for row in result['items'] if row.get('source') == event['source']
                    and row.get('source_event_id') == event['source_event_id']]
            if len(rows) > 1:
                raise Conflict('Multiple source identities')
            if not rows:
                return False
            row = rows[0]
            if (row.get('role') != event['role'] or row.get('text') != event['text']
                    or datetime.fromisoformat(row['created_at'].replace('Z', '+00:00'))
                    != datetime.fromisoformat(event['created_at'].replace('Z', '+00:00'))):
                raise Conflict('Remote source content differs; no overwrite permitted')
            return True

        if existing():
            return 'already_archived'
        result = request('/api/ingest-raw', {'source': event['source'], 'events': [event]})
        if result.get('rejected') or not existing():
            raise Conflict('Raw archive confirmation failed')
        return 'archived'

    def prepare(self, window, receipt, query):
        if not self.config.get('hook_enabled') or not self.config.get('hook_ready'):
            return {'state': 'unconfigured', 'context': '', 'ids': []}
        if time.monotonic() < self._retry_after:
            return {'state': 'unavailable', 'context': '', 'ids': []}
        try:
            response = self.transport.post(self.base + '/api/hook/recall',
                headers={'Authorization': 'Bearer ' + self.token},
                json={'query': query, 'session_id': window, 'delivered_ids': self.ledger.recent(window),
                      'max_notes': 2, 'max_context_chars': 4200},
                timeout=(.5, min(4, float(self.config.get('recall_timeout', 2)))), allow_redirects=False)
            response.raise_for_status()
            if response.status_code != 200:
                raise ValueError('Unexpected response')
            result = response.json()
            ids, context = result.get('recalled_ids'), result.get('additional_context')
            if (result.get('ok') is not True or not isinstance(ids, list)
                    or any(not isinstance(k, str) for k in ids) or not isinstance(context, str)):
                raise ValueError('Invalid recall shape')
            if len(context) > 16000:
                raise ValueError('Recall response exceeds budget')
            return {'state': 'prepared', 'context': context, 'ids': ids, 'receipt': receipt, 'window': window}
        except Exception:
            self._retry_after = time.monotonic() + 60
            LOG.warning('Serein recall unavailable; normal chat continues')
            return {'state': 'unavailable', 'context': '', 'ids': []}

    def acknowledge(self, turn):
        if turn.get('state') != 'prepared':
            return
        try:
            self.ledger.delivered(turn['receipt'], turn['window'], turn['ids'])
        except Exception:
            LOG.warning('Serein delivery acknowledgement deferred; chat retained')

    def definitions(self):
        if not self.config.get('tools_enabled'):
            return []
        if time.monotonic() - self._discovered_at < 60 and self._definitions is not None:
            return self._definitions
        self._discovered_at = time.monotonic()
        try:
            definitions, _ = self.mcp.list_tools(self.base + '/serein/mcp', timeout=2, access_token=self.token)
            result = []
            for item in definitions:
                name = item.get('name')
                if name not in ALLOWED_TOOLS:
                    continue
                schema = json.loads(canonical(item.get('inputSchema') or {}))
                # No model-authored evidence IDs/quotes may impersonate archived facts.
                if name == 'write_scene':
                    schema.get('properties', {}).pop('evidence_refs', None)
                result.append({'type': 'function', 'function': {'name': 'serein_' + name,
                    'description': item.get('description', ''), 'parameters': schema}})
            self._definitions = result
        except Exception:
            self._definitions = []
            LOG.warning('Serein tools unavailable; normal chat continues')
        return self._definitions

    def execute(self, name, args, window, turn_id):
        local = name.removeprefix('serein_')
        if name != 'serein_' + local or local not in ALLOWED_TOOLS:
            return None
        outcome = {'ok': False, 'content': '记忆服务暂不可用；请勿重复执行状态未知的写入。',
                   'error': 'serein_unavailable', 'duration_ms': 0, 'source': 'mcp', 'server': 'Serein'}
        if not self.config.get('tools_enabled'):
            return outcome
        if 'evidence_refs' in args:
            return {**outcome, 'error': 'unverified_evidence', 'content': '尚未启用来源绑定，不能添加未经核实的原话证据。'}
        fingerprint = digest([window, local, args])
        identifier = digest([turn_id, fingerprint])
        try:
            if local in WRITES:
                previous = self.ledger.begin(identifier, fingerprint)
                if previous is not None:
                    return previous
            text, _ = self.mcp.call_tool(self.base + '/serein/mcp', local, args,
                                         timeout=8, access_token=self.token)
            result = {**outcome, 'ok': True, 'content': text, 'error': ''}
            if local in WRITES:
                self.ledger.complete(identifier, result)
            return result
        except Exception:
            return outcome


def configured():
    """Load only the explicitly selected private file; malformed config fails open."""
    global _client, _signature
    path = os.environ.get('MORROW_SEREIN_CONFIG', '')
    if not path:
        return None
    try:
        stat = os.stat(path)
        signature = (path, stat.st_mtime_ns, stat.st_size)
        with _lock:
            if _signature != signature:
                value = json.loads(Path(path).read_text(encoding='utf-8'))
                if value.get('raw_sync_enabled'):
                    raise ValueError('Source withdrawal transport has not been verified')
                _client = Bridge(value) if value.get('enabled') else None
                _signature = signature
            return _client
    except Exception:
        LOG.warning('Serein configuration unavailable; normal chat continues')
        return None


def suppress_legacy():
    bridge = configured()
    return bool(bridge and bridge.config.get('replace_legacy'))


def for_chat(session_id, user_message_id, db_path=None):
    bridge = configured()
    # Background activities and regenerated replies have no stable new user turn.
    if not bridge or not user_message_id:
        return None
    if db_path:
        import memory_outbox
        if memory_outbox.quarantine(db_path):
            return None
    return bridge


def observe_stream(events, bridge, turn):
    """Confirm only an exhausted, non-error final text round; never on close()."""
    failed = False
    text = False
    called_tools = False
    for kind, payload in events:
        if kind == 'model_round_start':
            text = False
            called_tools = False
        elif kind == 'error':
            failed = True
        elif kind == 'delta' and str(payload).strip():
            text = True
        elif kind == 'tool_start':
            called_tools = True
        yield kind, payload
    if not failed and text and not called_tools:
        bridge.acknowledge(turn)

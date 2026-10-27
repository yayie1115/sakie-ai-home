"""Ordered source receipts, shared by the isolated sender and receiver.

The receiver ledger MUST live in the same database and transaction as its
projection. Neither side may prune receipts/outbox history under this protocol.
No HTTP endpoint or production capture is enabled by this module.
"""
import hashlib
import json

PROTOCOL = 'morrow-source-v1'
GENESIS = '0' * 64


class SourceConflict(ValueError):
    pass


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def envelope(event, sequence, previous_sequence, previous_hash):
    body = {**event, 'protocol': PROTOCOL, 'sequence': sequence,
            'previous_sequence': previous_sequence, 'previous_hash': previous_hash}
    validate(body)
    return body


def validate(event):
    if not isinstance(event, dict) or event.get('protocol') != PROTOCOL:
        raise SourceConflict('Unsupported source protocol')
    if set(event) != {'protocol', 'sequence', 'previous_sequence', 'previous_hash',
                      'event_id', 'instance_id', 'kind', 'message_id', 'session_id', 'message'}:
        raise SourceConflict('Unexpected source envelope fields')
    for key in ('instance_id', 'event_id'):
        if not isinstance(event[key], str) or not event[key] or len(event[key]) > 128:
            raise SourceConflict('Invalid source identity')
    if (type(event['sequence']) is not int or type(event['previous_sequence']) is not int
            or event['previous_sequence'] < 0 or event['sequence'] != event['previous_sequence'] + 1):
        raise SourceConflict('Invalid source order')
    digest = event['previous_hash']
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise SourceConflict('Invalid source chain')
    if event['previous_sequence'] == 0 and digest != GENESIS:
        raise SourceConflict('Invalid source genesis')
    if event['kind'] not in ('upsert', 'withdraw', 'withdraw_session'):
        raise SourceConflict('Unsupported source operation')
    if type(event['session_id']) is not int or event['session_id'] < 1:
        raise SourceConflict('Invalid source session')
    if event['kind'] != 'withdraw_session' and (type(event['message_id']) is not int or event['message_id'] < 1):
        raise SourceConflict('Invalid source message')
    if event['kind'] == 'withdraw_session' and event['message_id'] is not None:
        raise SourceConflict('Session withdrawal cannot name a message')
    if not isinstance(event['message'], dict):
        raise SourceConflict('Invalid source snapshot')


def initialize(db):
    # The caller controls the transaction. Do not use executescript (implicit
    # commit), and never create a second receipt database beside the projection.
    db.execute('''CREATE TABLE IF NOT EXISTS morrow_source_streams(
        instance TEXT PRIMARY KEY, sequence INTEGER NOT NULL, hash TEXT NOT NULL)''')
    db.execute('''CREATE TABLE IF NOT EXISTS morrow_source_stream_receipts(
        instance TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT UNIQUE NOT NULL,
        hash TEXT NOT NULL, PRIMARY KEY(instance,sequence))''')


def head(db, instance):
    row = db.execute('SELECT sequence,hash FROM morrow_source_streams WHERE instance=?', (instance,)).fetchone()
    receipt = db.execute('SELECT sequence,hash FROM morrow_source_stream_receipts WHERE instance=? ORDER BY sequence DESC LIMIT 1',
                         (instance,)).fetchone()
    if (tuple(row) if row else None) != (tuple(receipt) if receipt else None):
        raise SourceConflict('Receiver cursor and receipts disagree; recovery review required')
    return {'protocol': PROTOCOL, 'instance_id': instance,
            'sequence': row[0] if row else 0, 'hash': row[1] if row else GENESIS}


def check(db, event):
    """Return an existing ACK, or permit exactly the next chain link."""
    validate(event)
    stamp = fingerprint(event)
    current = head(db, event['instance_id'])
    row = db.execute('SELECT sequence,event_id,hash FROM morrow_source_stream_receipts WHERE instance=? AND sequence=?',
                     (event['instance_id'], event['sequence'])).fetchone()
    if row:
        if tuple(row) != (event['sequence'], event['event_id'], stamp):
            raise SourceConflict('Source identity conflicts with durable receipt')
        return acknowledgement(event)
    if db.execute('SELECT 1 FROM morrow_source_stream_receipts WHERE event_id=?', (event['event_id'],)).fetchone():
        raise SourceConflict('Event identity reused in another stream position')
    if (event['previous_sequence'], event['previous_hash']) != (current['sequence'], current['hash']):
        raise SourceConflict('Source cursor mismatch; reconcile backup lineage before proceeding')
    return None


def acknowledgement(event):
    return {'protocol': PROTOCOL, 'instance_id': event['instance_id'], 'event_id': event['event_id'],
            'sequence': event['sequence'], 'hash': fingerprint(event), 'state': 'applied'}


def record(db, event):
    """Called only AFTER projection writes, in that SAME transaction."""
    stamp = fingerprint(event)
    db.execute('INSERT INTO morrow_source_stream_receipts VALUES (?,?,?,?)',
               (event['instance_id'], event['sequence'], event['event_id'], stamp))
    db.execute('INSERT INTO morrow_source_streams VALUES (?,?,?) ON CONFLICT(instance) DO UPDATE SET sequence=excluded.sequence,hash=excluded.hash',
               (event['instance_id'], event['sequence'], stamp))
    return acknowledgement(event)

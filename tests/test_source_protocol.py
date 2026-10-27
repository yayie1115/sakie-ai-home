"""Offline ordered transport tests; never register/enable a production receiver."""
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import memory_outbox as outbox
import source_protocol as protocol
import backup_service


class OrderedSourceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'synthetic.db'
        self.db = sqlite3.connect(self.path); self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE sessions(id INTEGER PRIMARY KEY);
            CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id INTEGER,role TEXT,content TEXT,created_at TEXT,
              active INTEGER DEFAULT 0,hidden INTEGER DEFAULT 0,versions TEXT DEFAULT '[]',attachments TEXT DEFAULT '[]');
            INSERT INTO sessions VALUES(1);''')
        outbox.initialize(self.db)
        self.db.execute('UPDATE memory_bridge_control SET enabled=1'); self.db.commit()
        self.instance = self.db.execute('SELECT instance_id FROM memory_bridge_control').fetchone()[0]
        self.remote = sqlite3.connect(Path(self.temp.name) / 'receiver.db'); self.addCleanup(self.remote.close)
        protocol.initialize(self.remote)
        self.remote.execute('CREATE TABLE projected(id TEXT PRIMARY KEY,text TEXT)'); self.remote.commit()
        self.patch = patch('serein_bridge.SOURCE_RETRACTION_VERIFIED', True); self.patch.start(); self.addCleanup(self.patch.stop)

    def add(self, number):
        self.db.execute("INSERT INTO messages(id,session_id,role,content,created_at) VALUES(?,1,'user',?,'2026-01-01T00:00:00Z')",
                        (number, 'synthetic ' + str(number))); self.db.commit()

    def inspect(self, instance):
        return protocol.head(self.remote, instance)

    def send(self, event, fail_before_commit=False):
        with self.remote:
            ack = protocol.check(self.remote, event)
            if ack: return ack
            self.remote.execute('INSERT INTO projected VALUES (?,?)', (event['event_id'], event['message']['text']))
            result = protocol.record(self.remote, event)
            if fail_before_commit: raise TimeoutError('synthetic interrupt')
        return result

    def drain(self, **kwargs):
        return outbox.drain(self.path, kwargs.pop('send', self.send), inspect=kwargs.pop('inspect', self.inspect), **kwargs)

    def wire(self, number=1, prev=0, digest=protocol.GENESIS):
        return protocol.envelope({'event_id':'synthetic-'+str(number),'kind':'upsert','instance_id':self.instance,
            'message_id':number,'session_id':1,'message':{'text':'fiction'}}, number, prev, digest)

    def test_order_and_bounded_batch(self):
        for n in range(1,4): self.add(n)
        self.assertEqual(self.drain(limit=2)['acknowledged'],2)
        self.assertEqual(self.inspect(self.instance)['sequence'],2)
        self.assertEqual(self.drain()['acknowledged'],1)
        self.assertEqual(self.drain()['acknowledged'],0)

    def test_missing_handshake_never_sends(self):
        self.add(1)
        self.assertEqual(outbox.drain(self.path,lambda e:self.fail('must not send'))['status'],
                         'disabled_missing_cursor_handshake')

    def test_out_of_order_and_bad_chain_rejected(self):
        with self.assertRaises(protocol.SourceConflict): self.send(self.wire(2,1,'a'*64))
        first = self.wire(); self.send(first)
        with self.assertRaises(protocol.SourceConflict): self.send(self.wire(2,1,'b'*64))
        self.assertEqual(self.inspect(self.instance)['sequence'],1)

    def test_same_id_conflict_and_duplicate_are_durable(self):
        event = self.wire(); self.assertEqual(self.send(event),self.send(event))
        with self.assertRaises(protocol.SourceConflict): self.send({**event,'message':{'text':'other'}})
        self.assertEqual(self.remote.execute('SELECT count(*) FROM projected').fetchone()[0],1)

    def test_receipt_rolls_back_with_projection(self):
        with self.assertRaises(TimeoutError): self.send(self.wire(),True)
        self.assertEqual(self.inspect(self.instance)['sequence'],0)
        self.assertEqual(self.remote.execute('SELECT count(*) FROM projected').fetchone()[0],0)
        self.send(self.wire())

    def test_wrong_ack_retains_inflight_then_recovers(self):
        self.add(1)
        self.assertEqual(self.drain(send=lambda e:{**protocol.acknowledgement(e),'hash':'f'*64})['status'],'retry_pending')
        self.assertEqual(self.db.execute('SELECT state FROM memory_bridge_outbox').fetchone()[0],'inflight')
        self.assertEqual(self.drain()['acknowledged'],1)

    def test_lost_ack_proven_by_remote_head_without_duplicate_send(self):
        self.add(1)
        def lost(event): self.send(event); raise TimeoutError()
        self.assertEqual(self.drain(send=lost)['status'],'retry_pending')
        self.assertEqual(self.drain(send=lambda e:self.fail('already committed'))['acknowledged'],1)

    def test_receiver_restore_replays_even_previously_acknowledged_rows(self):
        backup = sqlite3.connect(':memory:'); self.addCleanup(backup.close); self.remote.backup(backup)
        self.add(1); self.drain(); self.add(2); self.drain()
        backup.backup(self.remote)
        self.assertEqual(self.drain()['acknowledged'],2)
        self.assertEqual(self.remote.execute('SELECT count(*) FROM projected').fetchone()[0],2)

    def test_sender_old_backup_stops_if_remote_ahead(self):
        self.add(1); self.drain()
        backup=sqlite3.connect(':memory:'); self.addCleanup(backup.close); self.db.backup(backup)
        self.add(2); self.drain(); backup.backup(self.db)
        before = self.remote.total_changes
        self.assertEqual(self.drain()['status'],'cursor_conflict')
        self.assertEqual(self.remote.total_changes,before)

    def test_divergent_sender_suffix_cannot_overwrite_receiver(self):
        self.add(1); self.drain()
        backup=sqlite3.connect(':memory:'); self.addCleanup(backup.close); self.db.backup(backup)
        self.add(2); self.drain(); backup.backup(self.db)
        self.add(2)
        self.assertEqual(self.drain()['status'],'cursor_conflict')
        self.assertEqual(self.remote.execute('SELECT count(*) FROM projected').fetchone()[0],2)

    def test_bad_status_and_timeout_send_nothing(self):
        self.add(1)
        for status in [{'protocol':protocol.PROTOCOL,'instance_id':'wrong','sequence':0,'hash':protocol.GENESIS},
                       {'protocol':protocol.PROTOCOL,'instance_id':self.instance,'sequence':True,'hash':protocol.GENESIS}]:
            self.assertEqual(self.drain(inspect=lambda i:status,send=lambda e:self.fail('must not send'))['status'],'cursor_conflict')
        def unavailable(i): raise TimeoutError()
        self.assertEqual(self.drain(inspect=unavailable)['status'],'retry_pending')

    def test_single_worker_lock_releases_on_exit(self):
        self.add(1)
        with outbox.delivery_lock(self.path) as locked:
            self.assertTrue(locked)
            self.assertEqual(self.drain()['status'],'worker_busy')
        self.assertEqual(self.drain()['acknowledged'],1)

    def test_invalid_envelopes_never_advance_cursor(self):
        valid=self.wire()
        for update in [{'sequence':True},{'sequence':3},{'previous_sequence':-1},{'session_id':'1'},
                       {'protocol':'other'},{'previous_hash':'bad'},{'extra':'field'}]:
            with self.assertRaises(protocol.SourceConflict): self.send({**valid,**update})
        self.assertEqual(self.inspect(self.instance)['sequence'],0)

    def test_damaged_receiver_cursor_refuses_replay(self):
        event=self.wire(); self.send(event)
        self.remote.execute('DELETE FROM morrow_source_streams'); self.remote.commit()
        with self.assertRaises(protocol.SourceConflict): self.inspect(self.instance)
        with self.assertRaises(protocol.SourceConflict): self.send(event)
        self.assertEqual(self.drain()['status'],'cursor_conflict')

    def test_network_call_does_not_hold_host_write_transaction(self):
        self.add(1)
        def send(event):
            self.add(2)
            return self.send(event)
        self.assertEqual(self.drain(send=send,limit=1)['acknowledged'],1)
        self.assertEqual(self.drain()['acknowledged'],1)

    def test_legacy_zip_restore_blocked_before_open_or_directory_creation(self):
        safety=Path(self.temp.name)/'must-not-create'
        with self.assertRaises(backup_service.BackupError) as error:
            backup_service.restore_backup(self.db,Path(self.temp.name)/'uploads',
                                          Path(self.temp.name)/'missing.zip',safety)
        self.assertIn('同步',str(error.exception))
        self.assertFalse(safety.exists())

    def test_disabling_capture_does_not_authorize_restore_over_retained_events(self):
        self.add(1)
        self.db.execute('UPDATE memory_bridge_control SET enabled=0'); self.db.commit()
        with self.assertRaises(backup_service.BackupError): backup_service._check_memory_source_restore(self.db)

    def test_unused_disabled_source_extension_preserves_legacy_restore_path(self):
        self.db.execute('UPDATE memory_bridge_control SET enabled=0'); self.db.commit()
        backup_service._check_memory_source_restore(self.db)


if __name__ == '__main__': unittest.main()

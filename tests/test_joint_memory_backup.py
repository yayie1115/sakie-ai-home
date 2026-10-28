"""New synthetic components only; no live backup or configured credentials."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import subprocess
import sys
from unittest.mock import patch

import joint_memory_backup as joint
import memory_outbox
import source_protocol as protocol


class JointBackupTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.paths={name:self.root/(name+'.db') for name in ('host','receiver','index')}
        self.host=sqlite3.connect(self.paths['host']);self.addCleanup(self.host.close)
        self.host.row_factory=sqlite3.Row
        self.host.executescript('''CREATE TABLE sessions(id INTEGER PRIMARY KEY);
            INSERT INTO sessions VALUES(1);
            CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id INTEGER,role TEXT,content TEXT,
                created_at TEXT,active INTEGER DEFAULT 0,hidden INTEGER DEFAULT 0,
                versions TEXT DEFAULT '[]',attachments TEXT DEFAULT '[]');''')
        memory_outbox.initialize(self.host)
        self.host.execute('UPDATE memory_bridge_control SET enabled=1,recall_blocked=1');self.host.commit()
        self.receiver=sqlite3.connect(self.paths['receiver']);self.addCleanup(self.receiver.close)
        protocol.initialize(self.receiver)
        self.receiver.execute('CREATE TABLE morrow_source_epoch(id INTEGER PRIMARY KEY,epoch INTEGER)')
        self.receiver.execute('INSERT INTO morrow_source_epoch VALUES(1,7)');self.receiver.commit()
        with closing(sqlite3.connect(self.paths['index'])) as db:
            db.execute('CREATE TABLE synthetic_index(id INTEGER PRIMARY KEY,text TEXT)');db.commit()
        self.assets=self.root/'identity';self.assets.mkdir();(self.assets/'instance.txt').write_text('synthetic identity')
        self.destination=self.root/'encrypted';self.destination.mkdir()
        self.password='synthetic-round-trip-only'

    def add(self,number=1):
        self.host.execute("INSERT INTO messages(id,session_id,role,content,created_at) VALUES(?,1,'user','Fiction','2026-01-01')",(number,))
        self.host.commit()

    def deliver(self):
        row=self.host.execute('SELECT * FROM memory_bridge_outbox ORDER BY sequence LIMIT 1').fetchone()
        instance=self.host.execute('SELECT instance_id FROM memory_bridge_control').fetchone()[0]
        event=protocol.envelope({'event_id':row['event_id'],'kind':row['kind'],'instance_id':instance,
            'message_id':row['message_id'],'session_id':row['session_id'],'message':json.loads(row['payload'])},1,0,protocol.GENESIS)
        with self.receiver:protocol.record(self.receiver,event)

    def backup(self):
        return joint.snapshot(self.paths,{'identity':self.assets},self.destination,self.password,writers_quiesced=True)

    def test_joint_round_trip_retains_epoch_lost_ack_and_block(self):
        self.add();self.deliver()
        package,_,state=self.backup()
        self.assertTrue(state['recall_blocked']);self.assertEqual(state['lost_ack_count'],1)
        target=self.root/'restored';self.assertEqual(joint.restore(package,target,self.password),state)
        with closing(sqlite3.connect(target/'databases'/'receiver.db')) as db:
            self.assertEqual(db.execute('SELECT epoch FROM morrow_source_epoch').fetchone()[0],7)
        self.assertFalse(state['release_certified'])

    def test_missing_coverage_or_quiescence_rejected(self):
        with self.assertRaises(ValueError):joint.snapshot(self.paths,{'identity':self.assets},self.destination,self.password)
        with self.assertRaises(ValueError):joint.snapshot({'host':self.paths['host']},{'identity':self.assets},self.destination,self.password,writers_quiesced=True)

    def test_restored_receiver_behind_ack_is_rejected(self):
        self.add();self.host.execute("UPDATE memory_bridge_outbox SET state='acknowledged'");self.host.commit()
        with self.assertRaisesRegex(ValueError,'older than acknowledged'):joint.lineage(self.host,self.receiver)

    def test_old_host_snapshot_and_fork_rejected(self):
        self.add();self.deliver()
        self.host.execute("UPDATE memory_bridge_outbox SET payload='{}'");self.host.commit()
        with self.assertRaisesRegex(ValueError,'fork'):joint.lineage(self.host,self.receiver)
        self.host.execute('DELETE FROM memory_bridge_outbox');self.host.commit()
        with self.assertRaisesRegex(ValueError,'older than receiver'):joint.lineage(self.host,self.receiver)

    def test_receiver_receipt_hole_rejected(self):
        self.add();self.deliver()
        self.receiver.execute('DELETE FROM morrow_source_stream_receipts');self.receiver.commit()
        with self.assertRaises(ValueError):joint.lineage(self.host,self.receiver)

    def test_all_declared_sqlite_writers_are_reserved(self):
        original=joint.tree_files
        def inspect(root):
            for path in self.paths.values():
                with closing(sqlite3.connect(path,timeout=0)) as db:
                    with self.assertRaises(sqlite3.OperationalError):db.execute('BEGIN IMMEDIATE')
            return original(root)
        with patch.object(joint,'tree_files',side_effect=inspect):self.backup()

    def test_asset_changes_abort_without_publishing(self):
        original=joint.tree_files;calls=[]
        def changing(root):
            calls.append(1)
            if len(calls)==2:(self.assets/'instance.txt').write_text('changed')
            return original(root)
        with patch.object(joint,'tree_files',side_effect=changing):
            with self.assertRaisesRegex(ValueError,'inventory changed'):self.backup()
        self.assertEqual(list(self.destination.iterdir()),[])

    def test_undeclared_database_in_assets_rejected(self):
        with closing(sqlite3.connect(self.assets/'hidden.bin')) as db:
            db.execute('CREATE TABLE sample(id INTEGER)');db.commit()
        with self.assertRaisesRegex(ValueError,'Undeclared SQLite'):self.backup()

    def test_wrong_password_and_existing_target_do_not_overwrite(self):
        package,_,_=self.backup();target=self.root/'restore'
        with self.assertRaises(Exception):joint.restore(package,target,'incorrect synthetic password')
        self.assertFalse(target.exists())
        target.mkdir();(target/'sentinel').write_text('keep')
        with self.assertRaises(ValueError):joint.restore(package,target,self.password)
        self.assertEqual((target/'sentinel').read_text(),'keep')

    def test_worker_lock_conflict_stops_snapshot(self):
        with memory_outbox.delivery_lock(self.paths['host']) as acquired:
            self.assertTrue(acquired)
            with self.assertRaisesRegex(ValueError,'worker is busy'):self.backup()

    def test_restored_copy_retries_lost_ack_in_new_process_and_continues(self):
        self.add();self.deliver()
        package,_,_=self.backup();target=self.root/'resumed'
        joint.restore(package,target,self.password)
        code='''import json,sqlite3,sys
from pathlib import Path
import source_protocol as p
import joint_memory_backup as j
root=Path(sys.argv[1])
host=sqlite3.connect(root/'databases'/'host.db');host.row_factory=sqlite3.Row
remote=sqlite3.connect(root/'databases'/'receiver.db')
instance=host.execute('SELECT instance_id FROM memory_bridge_control').fetchone()[0]
row=host.execute('SELECT * FROM memory_bridge_outbox').fetchone()
e=p.envelope({'event_id':row['event_id'],'kind':row['kind'],'instance_id':instance,'message_id':row['message_id'],
 'session_id':row['session_id'],'message':json.loads(row['payload'])},1,0,p.GENESIS)
assert p.check(remote,e)==p.acknowledgement(e)
host.execute("UPDATE memory_bridge_outbox SET state='acknowledged'");host.commit()
host.execute("INSERT INTO messages(id,session_id,role,content,created_at) VALUES(2,1,'user','Fiction two','2026-01-01')");host.commit()
row=host.execute('SELECT * FROM memory_bridge_outbox WHERE sequence=2').fetchone()
head=p.head(remote,instance)
e=p.envelope({'event_id':row['event_id'],'kind':row['kind'],'instance_id':instance,'message_id':row['message_id'],
 'session_id':row['session_id'],'message':json.loads(row['payload'])},2,head['sequence'],head['hash'])
with remote:
 assert p.check(remote,e) is None
 p.record(remote,e)
assert j.lineage(host,remote)['receiver']['sequence']==2
assert host.execute('SELECT recall_blocked FROM memory_bridge_control').fetchone()[0]==1
host.close();remote.close()
'''
        subprocess.run([sys.executable,'-c',code,str(target)],check=True,capture_output=True,timeout=20)
        self.assertEqual(self.host.execute('SELECT count(*) FROM messages').fetchone()[0],1)

    def test_corrupt_encrypted_package_rejected_without_restore_target(self):
        package,_,_=self.backup();damaged=self.root/'damaged.enc'
        content=bytearray(package.read_bytes());content[-1]^=1;damaged.write_bytes(content)
        with self.assertRaises(Exception):joint.restore(damaged,self.root/'corrupt',self.password)
        self.assertFalse((self.root/'corrupt').exists())

    def test_filtered_asset_cannot_silently_disappear_from_joint_manifest(self):
        (self.assets/'required.log').write_text('Synthetic declared asset')
        with self.assertRaisesRegex(ValueError,'inventory/hash mismatch'):self.backup()
        self.assertEqual(list(self.destination.iterdir()),[])


if __name__=='__main__':unittest.main()

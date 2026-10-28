"""Synthetic, opt-in host provenance. No provider or production database."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import subprocess
import sys
from unittest.mock import Mock

import context_provenance as context


class ContextTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'synthetic.db'
        self.db = context.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript('''
            CREATE TABLE sessions(id INTEGER PRIMARY KEY);
            INSERT INTO sessions VALUES(1);
            CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id INTEGER,role TEXT,content TEXT,
                created_at TEXT DEFAULT '2026-01-01',hidden INTEGER DEFAULT 0,proactive INTEGER DEFAULT 0,
                active INTEGER DEFAULT 0,versions TEXT DEFAULT '[]',attachments TEXT DEFAULT '[]',tool_log TEXT DEFAULT '[]');
            CREATE TABLE conversation_summaries(session_id INTEGER PRIMARY KEY,summary TEXT,
                covered_through_message_id INTEGER DEFAULT 0,raw_overlap_count INTEGER DEFAULT 0);
            CREATE TABLE memory_entries(id INTEGER PRIMARY KEY,content TEXT,kind TEXT DEFAULT 'fixed',
                tags TEXT DEFAULT '[]',pinned INTEGER DEFAULT 0);
            CREATE TABLE persona(id INTEGER PRIMARY KEY,content TEXT);
            INSERT INTO persona VALUES(1,'Synthetic core');
            INSERT INTO messages(id,session_id,role,content) VALUES(1,1,'user','Fictional lantern');
        ''')
        context.initialize(self.db)
        self.db.execute('UPDATE morrow_context_control SET enabled=1')
        self.db.commit()

    def seal(self, trace):
        trace.record(self.db, 'message', 1)
        trace.seal()

    def generated(self, number=2):
        with context.generation(self.path, 1) as trace:
            self.seal(trace)
            self.db.execute("INSERT INTO messages(id,session_id,role,content) VALUES(?,1,'assistant','Fictional reply')", (number,))
            self.db.commit()
            return trace.identifier

    def test_disabled_is_backward_compatible(self):
        self.db.execute('UPDATE morrow_context_control SET enabled=0'); self.db.commit()
        with context.generation(self.path,1) as trace:self.assertIsNone(trace)
        self.db.execute("INSERT INTO memory_entries(content) VALUES('Synthetic')"); self.db.commit()

    def test_primary_manifest_is_durable_without_plaintext(self):
        with context.generation(self.path,1) as trace:
            self.seal(trace)
            row=self.db.execute('SELECT * FROM morrow_context_manifests').fetchone()
            self.assertNotIn('Fictional lantern',row['payload'])
            self.assertEqual(row['state'],'complete')
            self.assertTrue(context.valid_manifest(self.db,trace.identifier))
            self.assertEqual(trace.seal(),trace.identifier)

    def test_legacy_summary_is_unknown_not_fabricated(self):
        with context.owner(),self.db:
            self.db.execute("INSERT INTO conversation_summaries VALUES(1,'Legacy',1,0)")
        with context.generation(self.path,1) as trace:
            trace.record(self.db,'summary',1);trace.seal()
            self.assertFalse(context.valid_manifest(self.db,trace.identifier))
            self.assertTrue(context.valid_manifest(self.db,trace.identifier,allow_unknown=True))

    def test_tool_and_media_inputs_cannot_certify(self):
        self.db.execute('UPDATE messages SET attachments=?,tool_log=? WHERE id=1',
                        (json.dumps([{'path':'synthetic.png'}]),json.dumps([{'result':'Fiction'}])))
        self.db.commit()
        with context.generation(self.path,1) as trace:
            context.record_message(self.db,self.db.execute('SELECT * FROM messages WHERE id=1').fetchone())
            trace.seal()
            self.assertIn('media_without_complete_dependency_manifest',trace.unknown)
            self.assertFalse(context.valid_manifest(self.db,trace.identifier))

    def test_expected_read_mismatch_is_unknown(self):
        with context.generation(self.path,1) as trace:
            trace.record(self.db,'message',1,{'content':'stale'});trace.seal()
            self.assertFalse(context.valid_manifest(self.db,trace.identifier))

    def test_edit_invalidates_manifest_and_assistant_projection(self):
        identifier=self.generated()
        self.db.execute("UPDATE messages SET content='Corrected fictional input' WHERE id=1");self.db.commit()
        self.assertFalse(context.valid_manifest(self.db,identifier))
        self.assertFalse(context.readable(self.db,'message',2))
        self.assertEqual(self.db.execute('SELECT count(*) FROM messages').fetchone()[0],2)

    def test_delete_source_keeps_derived_record_but_hides_it(self):
        self.generated()
        self.db.execute('DELETE FROM messages WHERE id=1');self.db.commit()
        self.assertFalse(context.readable(self.db,'message',2))

    def test_cross_session_parent_dependency_invalidates(self):
        parent=self.generated()
        with context.generation(self.path,2) as trace:
            trace.record(self.db,'message',2);trace.seal();child=trace.identifier
        self.db.execute("UPDATE messages SET content='Different' WHERE id=1");self.db.commit()
        self.assertFalse(context.valid_manifest(self.db,parent))
        self.assertFalse(context.valid_manifest(self.db,child))

    def test_version_switch_revokes_even_when_text_matches(self):
        identifier=self.generated()
        self.db.execute('UPDATE messages SET active=1,versions=? WHERE id=1',
                        (json.dumps([{'content':'Fictional lantern'},{'content':'Fictional lantern'}]),))
        self.db.commit();self.assertFalse(context.valid_manifest(self.db,identifier))

    def test_transaction_rollback_does_not_revoke(self):
        identifier=self.generated()
        self.db.execute("UPDATE messages SET content='Uncommitted' WHERE id=1")
        self.db.rollback();self.assertTrue(context.valid_manifest(self.db,identifier))

    def test_unknown_legacy_assistant_is_quarantined_after_edit(self):
        self.db.execute("INSERT INTO messages(id,session_id,role,content) VALUES(2,1,'assistant','Legacy')")
        self.db.commit();self.assertTrue(context.readable(self.db,'message',2))
        self.db.execute("UPDATE messages SET content='New' WHERE id=1");self.db.commit()
        self.assertFalse(context.readable(self.db,'message',2))

    def test_all_unowned_legacy_memory_writes_blocked(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError,'memory_context_unverified'):
            self.db.execute("INSERT INTO memory_entries(content) VALUES('Fiction')")
        self.db.rollback()
        with context.owner(),self.db:
            self.db.execute("INSERT INTO memory_entries(id,content) VALUES(1,'Owner entry')")
        for sql in ["UPDATE memory_entries SET content='Changed' WHERE id=1",'DELETE FROM memory_entries WHERE id=1']:
            with self.assertRaisesRegex(sqlite3.IntegrityError,'memory_context_unverified'):self.db.execute(sql)
            self.db.rollback()

    def test_unregistered_connection_fails_closed(self):
        with closing(sqlite3.connect(self.path)) as other:
            with self.assertRaises(sqlite3.OperationalError):
                other.execute("INSERT INTO memory_entries(content) VALUES('Untrusted')")

    def test_owner_entry_survives_unrelated_quarantine(self):
        with context.owner(),self.db:
            self.db.execute("INSERT INTO memory_entries(id,content) VALUES(1,'Independent owner entry')")
        self.db.execute("UPDATE messages SET content='Changed' WHERE id=1");self.db.commit()
        self.assertTrue(context.readable(self.db,'memory',1))

    def test_summary_publish_race_rejected(self):
        with context.generation(self.path,1) as trace:
            self.seal(trace)
            with closing(context.connect(self.path)) as other,other:
                other.execute("UPDATE messages SET content='Concurrent correction' WHERE id=1")
            with self.assertRaisesRegex(sqlite3.IntegrityError,'summary_context_unverified'):
                self.db.execute("INSERT INTO conversation_summaries VALUES(1,'Stale summary',1,0)")
            self.db.rollback()

    def test_summary_chaining_flattens_original_leaves(self):
        with context.generation(self.path,1) as trace:
            self.seal(trace)
            self.db.execute("INSERT INTO conversation_summaries VALUES(1,'First',1,0)")
            context.bind(self.db,'summary',1);self.db.commit()
        with context.generation(self.path,1,'summary') as trace:
            trace.prior_summary(self.db,1);trace.seal()
            self.db.execute("UPDATE conversation_summaries SET summary='Second' WHERE session_id=1")
            context.bind(self.db,'summary',1);self.db.commit()
            self.assertTrue(context.valid_manifest(self.db,trace.identifier))
            self.assertEqual(list(trace.dependencies),[('message','1')])
        self.db.execute("UPDATE messages SET content='Changed' WHERE id=1");self.db.commit()
        self.assertFalse(context.readable(self.db,'summary',1))

    def test_prior_summary_concurrent_change_rejected(self):
        with context.owner(),self.db:self.db.execute("INSERT INTO conversation_summaries VALUES(1,'Old',1,0)")
        with context.generation(self.path,1,'summary') as trace:
            trace.prior_summary(self.db,1);trace.seal()
            with context.owner(),closing(context.connect(self.path)) as other,other:
                other.execute("UPDATE conversation_summaries SET summary='Owner change'")
            with self.assertRaisesRegex(sqlite3.IntegrityError,'summary_context_unverified'):
                self.db.execute("UPDATE conversation_summaries SET summary='Stale generated'")
            self.db.rollback()

    def test_manifest_tampering_rejected(self):
        identifier=self.generated()
        self.db.execute("UPDATE morrow_context_manifests SET payload='{}' WHERE id=?",(identifier,));self.db.commit()
        self.assertFalse(context.valid_manifest(self.db,identifier))

    def test_session_delete_invalidates_derived_context(self):
        identifier=self.generated()
        self.db.execute('DELETE FROM sessions WHERE id=1');self.db.commit()
        self.assertFalse(context.valid_manifest(self.db,identifier))

    def test_tool_result_changes_manifest_to_unknown(self):
        with context.generation(self.path,1) as trace:
            trace.record(self.db,'message',1)
            self.assertEqual(list(context.observe(iter([('tool_result',{'content':'Synthetic'})])))[0][0],'tool_result')
            self.assertFalse(context.valid_manifest(self.db,trace.identifier))

    def test_reopened_process_validates_persistent_manifest(self):
        identifier=self.generated()
        with closing(context.connect(self.path)) as other:
            self.assertTrue(context.valid_manifest(other,identifier))

    def test_initialization_repeat_does_not_enable_or_clear_quarantine(self):
        self.db.execute('INSERT INTO morrow_context_quarantine VALUES(1)');self.db.commit()
        context.initialize(self.db)
        self.assertEqual(self.db.execute('SELECT count(*) FROM morrow_context_quarantine').fetchone()[0],1)

    def test_real_child_process_validates_and_revokes_saved_manifest(self):
        identifier=self.generated()
        code='''import sys,context_provenance as c
with c.connect(sys.argv[1]) as db:
 assert c.valid_manifest(db,sys.argv[2])
 db.execute("UPDATE messages SET content='Child correction' WHERE id=1")
 assert not c.valid_manifest(db,sys.argv[2])
'''
        subprocess.run([sys.executable,'-c',code,str(self.path),identifier],check=True,capture_output=True,timeout=15)
        self.assertFalse(context.readable(self.db,'message',2))

    def test_legacy_zip_restore_is_blocked_for_context_database(self):
        import backup_service
        with self.assertRaises(backup_service.BackupError):backup_service._check_memory_source_restore(self.db)

    def test_unknown_bridge_turn_cannot_downgrade_to_unbound_scene(self):
        import serein_bridge
        root=Path(self.temp.name)
        token=root/'token';token.write_text('synthetic-token-only')
        transport=Mock();mcp=Mock()
        bridge=serein_bridge.Bridge({'base_url':'http://127.0.0.1:8011','token_file':str(token),
            'ledger':str(root/'operations.db'),'instance_id':'synthetic','tools_enabled':True},transport,mcp)
        with context.generation(self.path,1) as trace:
            self.seal(trace)
            result=bridge.execute('serein_write_scene',{'content':'Fiction'},'window','turn')
        self.assertFalse(result['ok']);self.assertEqual(result['error'],'context_receipt_unverified')
        transport.post.assert_not_called();mcp.call_tool.assert_not_called()

    def test_real_history_projection_records_inputs_and_rejects_stale_reply(self):
        import chat_engine
        from unittest.mock import patch
        self.generated()
        with patch.object(chat_engine,'DB_PATH',str(self.path)),context.generation(self.path,1) as trace:
            history=chat_engine.get_history(1,limit=None)
            self.assertEqual(len(history),2)
            self.assertEqual(set(trace.dependencies),{('message','1'),('message','2')})
        self.db.execute("UPDATE messages SET content='Correction' WHERE id=1");self.db.commit()
        with patch.object(chat_engine,'DB_PATH',str(self.path)):
            self.assertEqual(len(chat_engine.get_history(1,limit=None)),1)


if __name__=='__main__':unittest.main()

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock,patch

import auto_text_memory as auto
import serein_bridge


class AutoTextTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.path=self.root/'synthetic.db'
        self.db=sqlite3.connect(self.path);self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE memory_bridge_control(id INTEGER,enabled INTEGER,recall_blocked INTEGER);
            INSERT INTO memory_bridge_control VALUES(1,0,0);
            CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id INTEGER,role TEXT,content TEXT,
                active INTEGER DEFAULT 0,attachments TEXT DEFAULT '[]',hidden INTEGER DEFAULT 0,created_at TEXT DEFAULT '2026-01-01 12:00:00');
            INSERT INTO messages(id,session_id,role,content) VALUES(1,1,'user','我最喜欢虚构的蓝砂花。');''')
        token=self.root/'credential';token.write_text('synthetic-auto-token')
        self.mcp=Mock();self.mcp.call_tool.return_value=('已保存。\n[scene_id:synthetic-scene]','http')
        self.bridge=serein_bridge.Bridge({'base_url':'http://127.0.0.1:8011','token_file':str(token),
            'ledger':str(self.root/'bridge.db'),'instance_id':'synthetic','tools_enabled':True,'auto_text_memory_enabled':True},mcp=self.mcp)
        self.candidate={'remember':True,'kind':'preference','memory':'用户最喜欢虚构的蓝砂花。',
            'quote':'我最喜欢虚构的蓝砂花。','cues':['蓝砂花','喜欢的花']}

    def enqueue(self,mid=1):return auto.enqueue(self.path,1,mid,1,'synthetic-model',bridge=self.bridge)
    def process(self,extractor=None):return auto.run_one(self.path,self.bridge,extractor=extractor or (lambda *a:self.candidate),now=time.time()+1000)
    def job(self):return auto.status(self.bridge)['recent'][0]

    def test_natural_preference_without_remember_keyword_is_saved(self):
        self.assertIsNotNone(self.enqueue());self.assertTrue(self.process())
        self.assertEqual(self.job()['state'],'succeeded');self.assertEqual(self.job()['scene_id'],'synthetic-scene')
        self.assertIn('用户最喜欢虚构的蓝砂花',self.mcp.call_tool.call_args.args[2]['content'])
        self.assertNotIn('evidence_refs',self.mcp.call_tool.call_args.args[2])
        with self.bridge.ledger.connect() as db:self.assertIsNone(db.execute('SELECT candidate FROM auto_text_jobs').fetchone()[0])

    def test_question_or_greeting_can_be_semantically_skipped(self):
        self.enqueue();self.process(lambda *a:None)
        self.assertEqual(self.job()['state'],'skipped');self.mcp.call_tool.assert_not_called()

    def test_strict_json_and_invented_quote_are_rejected(self):
        for raw in ['not json','{"remember":"true"}','{"remember":false,"extra":1}',json.dumps({**self.candidate,'quote':'Not in the user text'})]:
            with self.subTest(raw=raw),self.assertRaises(ValueError):auto.validate(raw,'我最喜欢虚构的蓝砂花。')

    def test_explicit_requests_and_protected_mode_do_not_duplicate(self):
        with self.db:self.db.execute("UPDATE messages SET content='请记住：一条虚构信息' WHERE id=1")
        self.assertIsNone(self.enqueue())
        with self.db:self.db.execute('UPDATE memory_bridge_control SET enabled=1')
        self.assertIsNone(self.enqueue())

    def test_duplicate_submission_and_duplicate_quote_write_once(self):
        first=self.enqueue();self.assertEqual(first,self.enqueue());self.process()
        with self.db:self.db.execute("INSERT INTO messages(id,session_id,role,content) VALUES(2,1,'user','我最喜欢虚构的蓝砂花。')")
        self.enqueue(2);self.process()
        self.assertEqual(self.job()['error'],'duplicate_memory');self.assertEqual(self.mcp.call_tool.call_count,1)

    def test_changed_preference_creates_new_scene_without_editing_old(self):
        self.enqueue();self.process()
        with self.db:self.db.execute("INSERT INTO messages(id,session_id,role,content) VALUES(2,1,'user','现在我更喜欢虚构的银羽花。')")
        self.enqueue(2)
        candidate={**self.candidate,'memory':'用户现在更喜欢虚构的银羽花。','quote':'现在我更喜欢虚构的银羽花。','cues':['银羽花']}
        self.process(lambda *a:candidate)
        self.assertEqual(self.mcp.call_tool.call_count,2)
        self.assertTrue(all(call.args[1]=='write_scene' for call in self.mcp.call_tool.call_args_list))

    def test_classifier_failure_is_tracked_and_bounded(self):
        self.enqueue()
        def fail(*a):raise TimeoutError()
        self.process(fail);self.assertEqual(self.job()['state'],'queued')
        self.process(fail);self.assertEqual(self.job()['state'],'failed');self.assertEqual(self.job()['error'],'TimeoutError')
        self.mcp.call_tool.assert_not_called()

    def test_lost_write_response_remains_unknown_without_duplicate_after_resume(self):
        self.enqueue();self.mcp.call_tool.side_effect=TimeoutError()
        self.process();self.assertEqual(self.job()['state'],'unknown')
        with self.bridge.ledger.connect() as db:db.execute("UPDATE auto_text_jobs SET state='queued'")
        self.process();self.assertEqual(self.job()['state'],'unknown');self.assertEqual(self.mcp.call_tool.call_count,1)

    def test_edit_or_delete_before_extraction_skips_old_text(self):
        self.enqueue()
        with self.db:self.db.execute('DELETE FROM messages WHERE id=1')
        extractor=Mock();self.process(extractor)
        self.assertEqual(self.job()['error'],'source_changed');extractor.assert_not_called()

    def test_edit_during_extraction_does_not_write_old_candidate(self):
        self.enqueue()
        def changed(*a):
            with self.db:self.db.execute("UPDATE messages SET content='Changed' WHERE id=1")
            return self.candidate
        self.process(changed);self.assertEqual(self.job()['error'],'source_changed');self.mcp.call_tool.assert_not_called()

    def test_concurrent_claim_has_single_extractor(self):
        self.enqueue();entered=threading.Event();release=threading.Event()
        def slow(*a):entered.set();release.wait(5);return self.candidate
        with ThreadPoolExecutor(max_workers=1) as pool:
            task=pool.submit(self.process,slow);self.assertTrue(entered.wait(5))
            self.assertFalse(self.process());release.set();self.assertTrue(task.result(timeout=5))
        self.assertEqual(self.mcp.call_tool.call_count,1)

    def test_model_request_contains_only_current_user_text_without_tool_calls(self):
        import chat_engine
        client=Mock();client.__enter__=Mock(return_value=client);client.__exit__=Mock(return_value=False)
        response=client.post.return_value;response.status_code=200;response.content=b'{}'
        response.json.return_value={'choices':[{'message':{'content':json.dumps(self.candidate,ensure_ascii=False)}}]}
        with patch.object(auto.requests,'Session',return_value=client),patch.object(chat_engine,'get_provider',return_value={
            'base_url':'http://example.test/v1','api_key':'synthetic-key','format':'openai'}):
            result=auto.extract(self.path,{'provider_id':1,'model':'synthetic'},self.candidate['quote'],5)
        payload=client.post.call_args.kwargs['json']
        self.assertEqual(result,self.candidate);self.assertNotIn('tools',payload)
        self.assertEqual(payload['messages'][1]['content'],self.candidate['quote'])
        self.assertEqual(payload['max_tokens'],384)

    def test_status_does_not_expose_pending_memory_text(self):
        self.enqueue();self.process()
        self.assertNotIn('蓝砂花',json.dumps(auto.status(self.bridge),ensure_ascii=False))

    def test_enqueue_does_not_call_model_or_scene_on_request_thread(self):
        with patch.object(auto,'extract') as extract:
            self.enqueue();extract.assert_not_called();self.mcp.call_tool.assert_not_called()
        self.assertEqual(self.job()['state'],'queued')

    def test_status_api_requires_existing_login(self):
        import app
        with patch.object(app,'AUTH_PASSWORD','synthetic-password'),patch.object(serein_bridge,'configured',return_value=self.bridge):
            client=app.app.test_client()
            self.assertEqual(client.get('/api/serein-memory/auto-status').status_code,401)
            with client.session_transaction() as session:session['authed']=True
            response=client.get('/api/serein-memory/auto-status')
            self.assertEqual(response.status_code,200);self.assertTrue(response.json['enabled'])

    def test_new_session_wait_is_bounded_and_does_not_wait_on_own_job(self):
        self.enqueue();self.bridge.config['auto_text_recall_wait']=.05
        self.assertLess(auto.wait_for_recent_other_session(self.path,self.bridge,1,1),50)
        with self.db:self.db.execute("INSERT INTO messages(id,session_id,role,content) VALUES(2,2,'user','另一会话的问题')")
        elapsed=auto.wait_for_recent_other_session(self.path,self.bridge,2,2)
        self.assertGreaterEqual(elapsed,50);self.assertLess(elapsed,500)

    def test_title_is_not_evidence_that_a_user_statement_is_fiction(self):
        self.db.executescript("CREATE TABLE sessions(id INTEGER PRIMARY KEY,title TEXT);INSERT INTO sessions VALUES(1,'【虚构验收】自然偏好');")
        self.enqueue();self.process()
        self.assertNotIn('虚构验收资料',self.mcp.call_tool.call_args.args[2]['content'])
        self.assertIn(self.candidate['quote'],self.mcp.call_tool.call_args.args[2]['content'])

    def test_title_change_keeps_source_hash_job_identity_and_extraction_input(self):
        self.db.executescript("CREATE TABLE sessions(id INTEGER PRIMARY KEY,title TEXT);INSERT INTO sessions VALUES(1,'普通标题');")
        first=auto.source(self.path,1,1);job=self.enqueue()
        with self.db:self.db.execute("UPDATE sessions SET title='【虚构验收】另一个标题'")
        second=auto.source(self.path,1,1)
        self.assertEqual(first,second);self.assertEqual(job,self.enqueue())
        extractor=Mock(return_value=self.candidate);self.process(extractor)
        self.assertEqual(extractor.call_args.args[2],first['content'])
        with self.bridge.ledger.connect() as db:self.assertEqual(db.execute('SELECT count(*) FROM auto_text_jobs').fetchone()[0],1)


if __name__=='__main__':unittest.main()

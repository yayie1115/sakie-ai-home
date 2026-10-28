from contextlib import closing
import json
from pathlib import Path
import tempfile
import sqlite3
import unittest
from unittest.mock import Mock, patch

import serein_bridge as bridge
from aru_import import parse_markdown


class BridgeTests(unittest.TestCase):
    def test_auto_memory_personal_question_uses_existing_lookup_after_hook_skip(self):
        self.client.config['auto_text_memory_enabled']=True
        self.transport.post.return_value.json.return_value={'ok':True,'recalled_ids':[],
            'additional_context':'','debug':{'semantic_recall_debug':{'route_action':'skip'}}}
        self.mcp.call_tool.return_value=('[typed_memory ref=scene:synthetic]\n虚构偏好\n[/typed_memory]','http')
        result=self.client.prepare('window','receipt','我最喜欢的花是什么？')
        self.assertEqual(result['ids'],['scene:synthetic'])
        self.assertIn('虚构偏好',result['context'])
        self.assertEqual(self.mcp.call_tool.call_args.args[1],'recall_memory')
        self.assertEqual(self.mcp.call_tool.call_args.args[2]['mode'],'lookup')

    def test_auto_lookup_does_not_run_on_chitchat_or_existing_hook_result(self):
        self.client.config['auto_text_memory_enabled']=True
        self.client.prepare('window','receipt','我最喜欢的花是什么？')
        self.mcp.call_tool.assert_not_called()
        self.transport.post.return_value.json.return_value={'ok':True,'recalled_ids':[],
            'additional_context':'','debug':{'semantic_recall_debug':{'route_action':'skip'}}}
        self.client.prepare('window','receipt','今天阳光很好。')
        self.mcp.call_tool.assert_not_called()

    def test_auto_lookup_failure_is_empty_and_never_claimed_success(self):
        self.client.config['auto_text_memory_enabled']=True
        self.transport.post.return_value.json.return_value={'ok':True,'recalled_ids':[],
            'additional_context':'','debug':{'semantic_recall_debug':{'route_action':'skip'}}}
        self.mcp.call_tool.side_effect=TimeoutError()
        result=self.client.prepare('window','receipt','我最喜欢什么花？')
        self.assertEqual(result['ids'],[]);self.assertEqual(result['context'],'')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.token = root / 'credential'
        self.token.write_text('synthetic-credential-only')
        self.config = {'base_url': 'http://127.0.0.1:8011', 'token_file': str(self.token),
            'ledger': str(root / 'state.db'), 'instance_id': 'synthetic', 'tools_enabled': True,
            'hook_enabled': True, 'hook_ready': True}
        self.transport = Mock()
        response = self.transport.post.return_value
        response.status_code = 200
        response.json.return_value = {'ok': True, 'recalled_ids': ['scene:synthetic'],
                                     'additional_context': '虚构读书会定于周末。'}
        self.mcp = Mock()
        self.mcp.list_tools.return_value = ([{'name': name, 'inputSchema': {'type': 'object',
            'properties': {'evidence_refs': {'type': 'array'}}}}
            for name in ['read_memory', 'write_scene', 'edit_scene', 'pipeline_next']], 'http')
        self.mcp.call_tool.return_value = ('synthetic saved result', 'http')
        self.client = bridge.Bridge(self.config, self.transport, self.mcp)

    def explicit_fixture(self):
        path=Path(self.temp.name)/'explicit.db'
        with closing(sqlite3.connect(path)) as db, db:
            db.executescript('''CREATE TABLE memory_bridge_control(id INTEGER,enabled INTEGER,recall_blocked INTEGER);
                INSERT INTO memory_bridge_control VALUES(1,0,0);
                CREATE TABLE messages(id INTEGER,session_id INTEGER,role TEXT,content TEXT,attachments TEXT,hidden INTEGER);
                INSERT INTO messages VALUES(1,1,'user','请记住：虚构项目「珊瑚台」的口令是 TEST-3141','[]',0);
                INSERT INTO messages VALUES(2,1,'user','旧聊天，不能被本轮复制','[]',0);''')
        self.client.config['explicit_text_memory_enabled']=True
        return path

    def test_explicit_text_uses_current_row_and_existing_idempotent_scene_writer(self):
        path=self.explicit_fixture()
        first=self.client.remember_explicit_text(path,1,1,'w','turn')
        self.assertTrue(first['ok'])
        args=self.mcp.call_tool.call_args.args[2]
        self.assertIn('TEST-3141',args['content']);self.assertNotIn('旧聊天',args['content'])
        self.assertEqual(args['cues'],['珊瑚台']);self.assertNotIn('evidence_refs',args)
        self.assertEqual(self.client.remember_explicit_text(path,1,1,'w','turn'),first)
        self.assertEqual(self.mcp.call_tool.call_count,1)

    def test_explicit_text_does_not_capture_questions_negation_or_attachments(self):
        path=self.explicit_fixture()
        for text,attachments in [('你还记得上次吗','[]'),('请不要记住这条','[]'),('请记住这张图','[{"type":"image"}]')]:
            with closing(sqlite3.connect(path)) as db, db:db.execute('UPDATE messages SET content=?,attachments=? WHERE id=1',(text,attachments))
            self.assertIsNone(self.client.remember_explicit_text(path,1,1,'w','t'))
        self.mcp.call_tool.assert_not_called()

    def test_explicit_text_cannot_bypass_protected_source_mode(self):
        path=self.explicit_fixture()
        with closing(sqlite3.connect(path)) as db, db:db.execute('UPDATE memory_bridge_control SET enabled=1')
        self.assertIsNone(self.client.remember_explicit_text(path,1,1,'w','t'))
        self.client.config['source_gateway_enabled']=True
        self.assertIsNone(self.client.remember_explicit_text(path,1,1,'w','t'))
        self.mcp.call_tool.assert_not_called()

    def test_explicit_text_timeout_is_not_retried_or_reported_saved(self):
        path=self.explicit_fixture();self.mcp.call_tool.side_effect=TimeoutError()
        self.assertFalse(self.client.remember_explicit_text(path,1,1,'w','t')['ok'])
        self.assertFalse(self.client.remember_explicit_text(path,1,1,'w','t')['ok'])
        self.assertEqual(self.mcp.call_tool.call_count,1)

    def test_explicit_text_receipt_is_emitted_and_given_to_chat(self):
        import chat_engine
        self.client.config['explicit_text_memory_enabled']=True
        outcome={'ok':True,'content':'已保存。\n[scene_id:synthetic-scene]','error':'','duration_ms':1,'source':'mcp','server':'Serein'}
        seen={}
        def generated(*args,**kwargs):
            seen['system']=args[3];seen['tools']=kwargs['extra_tools']
            yield 'delta','synthetic answer'
        with patch.object(bridge,'for_chat',return_value=self.client), \
             patch.object(self.client,'remember_explicit_text',return_value=outcome), \
             patch.object(chat_engine,'get_provider',return_value={'base_url':'http://example.test/v1','api_key':'synthetic-only','format':'openai','id':1,'name':'synthetic'}), \
             patch.object(chat_engine,'latest_user_text',return_value='synthetic'), \
             patch.object(chat_engine,'build_system_sections',return_value={'stable':'unchanged persona','volatile':''}), \
             patch.object(chat_engine,'get_conversation_summary',return_value=''), \
             patch.object(chat_engine,'get_history',return_value=[]), \
             patch.object(chat_engine.tools,'openai_tools',return_value=[]), \
             patch.object(chat_engine,'_run_openai_tool_loop',side_effect=generated):
            events=list(chat_engine.stream_chat(1,model='synthetic',current_user_message_id=8))
        self.assertIn('unchanged persona',seen['system']);self.assertIn('[scene_id:synthetic-scene]',seen['system'])
        self.assertTrue(any(kind=='tool_result' and value['ok'] for kind,value in events))
        self.assertFalse(any(tool['function']['name']=='serein_write_scene' for tool in seen['tools']))

    def test_prepare_is_not_delivery(self):
        turn = self.client.prepare('w', 'r', '虚构问题')
        self.assertEqual(turn['ids'], ['scene:synthetic'])
        self.assertEqual(self.client.ledger.recent('w'), [])
        self.assertEqual(self.transport.post.call_args.kwargs['json']['delivered_ids'], [])
        self.assertFalse(self.transport.post.call_args.kwargs['allow_redirects'])

    def test_success_ack_survives_reconstruction(self):
        turn = self.client.prepare('w', 'r', '虚构问题')
        list(bridge.observe_stream([('model_round_start', {}), ('delta', '虚构答案')], self.client, turn))
        self.assertEqual(bridge.Ledger(self.config['ledger']).recent('w'), ['scene:synthetic'])
        self.assertEqual(self.client.ledger.recent('different-window'), [])

    def test_duplicate_ack_and_conflict(self):
        ledger = self.client.ledger
        ledger.delivered('r', 'w', ['a']); ledger.delivered('r', 'w', ['a'])
        with self.assertRaises(bridge.Conflict):
            ledger.delivered('r', 'other', ['a'])
        with self.assertRaises(bridge.Conflict):
            ledger.delivered('r', 'w', ['b'])

    def test_recent_five_includes_empty_successes(self):
        ledger = self.client.ledger
        ledger.delivered('r0', 'w', ['a'])
        for i in range(1, 6):
            ledger.delivered(str(i), 'w', [])
        self.assertEqual(ledger.recent('w'), [])

    def test_failed_stream_never_ack(self):
        turn = self.client.prepare('w', 'r', '虚构问题')
        list(bridge.observe_stream([('delta', '部分'), ('error', {})], self.client, turn))
        self.assertEqual(self.client.ledger.recent('w'), [])

    def test_cancelled_stream_never_ack(self):
        turn = self.client.prepare('w', 'r', '虚构问题')
        stream = bridge.observe_stream(iter([('delta', '部分'), ('delta', '剩余')]), self.client, turn)
        next(stream); stream.close()
        self.assertEqual(self.client.ledger.recent('w'), [])

    def test_tool_continuation_only_one_final_ack(self):
        turn = self.client.prepare('w', 'r', '虚构问题')
        events = [('model_round_start', {}), ('delta', '工具前文字'), ('tool_start', {}),
                  ('tool_result', {}), ('model_round_start', {}), ('delta', '最终答案')]
        list(bridge.observe_stream(events, self.client, turn))
        self.assertEqual(self.transport.post.call_count, 1)
        with self.client.ledger.connect() as db:
            self.assertEqual(db.execute('select count(*) from deliveries').fetchone()[0], 1)

    def test_tool_budget_exhaustion_not_success(self):
        turn = self.client.prepare('w', 'r', '虚构问题')
        list(bridge.observe_stream([('delta', '思考'), ('tool_start', {})], self.client, turn))
        self.assertEqual(self.client.ledger.recent('w'), [])

    def test_recall_outage_circuit_and_fail_open(self):
        self.transport.post.side_effect = TimeoutError()
        self.assertEqual(self.client.prepare('w', 'r', 'q')['context'], '')
        self.client.prepare('w', 'r2', 'q')
        self.assertEqual(self.transport.post.call_count, 1)

    def test_unconfigured_hook_no_request(self):
        self.config['hook_ready'] = False
        self.assertEqual(self.client.prepare('w', 'r', 'q')['state'], 'unconfigured')
        self.transport.post.assert_not_called()

    def test_invalid_recall_shape_not_injected(self):
        self.transport.post.return_value.json.return_value = {'ok': True, 'recalled_ids': 'invalid'}
        self.assertEqual(self.client.prepare('w', 'r', 'q')['context'], '')

    def test_loopback_boundary(self):
        for url in ['http://example.com', 'https://example.com', 'http://127.0.0.1/x',
                    'http://user@127.0.0.1:8011', 'http://127.0.0.1:8011?x=1']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                bridge.Bridge({**self.config, 'base_url': url}, self.transport, self.mcp)

    def test_mcp_tool_allowlist_and_evidence_guard(self):
        definitions = self.client.definitions()
        self.assertNotIn('serein_pipeline_next', [d['function']['name'] for d in definitions])
        write = next(d for d in definitions if d['function']['name'] == 'serein_write_scene')
        self.assertNotIn('evidence_refs', write['function']['parameters']['properties'])
        result = self.client.execute('serein_write_scene', {'evidence_refs': []}, 'w', 't')
        self.assertFalse(result['ok']); self.mcp.call_tool.assert_not_called()

    def test_write_success_retry_cached(self):
        first = self.client.execute('serein_write_scene', {'content': '虚构场景'}, 'w', 't')
        again = self.client.execute('serein_write_scene', {'content': '虚构场景'}, 'w', 't')
        self.assertTrue(first['ok']); self.assertEqual(first, again)
        self.assertEqual(self.mcp.call_tool.call_count, 1)

    def test_lost_write_ack_not_repeated_even_after_restart(self):
        self.mcp.call_tool.side_effect = TimeoutError()
        self.assertFalse(self.client.execute('serein_write_scene', {'content': '虚构场景'}, 'w', 't')['ok'])
        restored = bridge.Bridge(self.config, self.transport, self.mcp)
        self.assertFalse(restored.execute('serein_write_scene', {'content': '虚构场景'}, 'w', 'next-turn')['ok'])
        self.assertEqual(self.mcp.call_tool.call_count, 1)

    def test_raw_ids_duplicates_conflicts_and_gate(self):
        ledger = self.client.ledger
        ledger.enqueue('message:v1', {'text': '虚构原文'})
        ledger.enqueue('message:v1', {'text': '虚构原文'})
        with self.assertRaises(bridge.Conflict):
            ledger.enqueue('message:v1', {'text': '不同原文'})
        sender = Mock()
        with self.assertRaises(bridge.Conflict):
            ledger.flush(sender, retraction_verified=True)
        sender.assert_not_called()
        with ledger.connect() as db:
            self.assertEqual(db.execute('select count(*) from raw_outbox').fetchone()[0], 1)

    def test_unsafe_config_disables_adapter(self):
        path = Path(self.temp.name) / 'config.json'
        path.write_text(json.dumps({**self.config, 'enabled': True, 'raw_sync_enabled': True}))
        with patch.dict('os.environ', {'MORROW_SEREIN_CONFIG': str(path)}):
            self.assertIsNone(bridge.configured())

    def test_outbox_lost_ack_recovers_in_order_with_verified_sender(self):
        ledger = self.client.ledger
        ledger.enqueue('a', {'source_event_id': 'a'})
        ledger.enqueue('b', {'source_event_id': 'b'})
        remote = set(); calls = []
        def sender(event):
            key = event['source_event_id']; calls.append(key)
            if key not in remote:
                remote.add(key)
                if key == 'a':
                    raise TimeoutError('synthetic acknowledgement lost')
        # Only a synthetic test can supply this not-yet-verified capability.
        with patch.object(bridge, 'SOURCE_RETRACTION_VERIFIED', True):
            self.assertEqual(ledger.flush(sender, retraction_verified=True), 0)
            restored = bridge.Ledger(self.config['ledger'])
            self.assertEqual(restored.flush(sender, retraction_verified=True), 2)
            self.assertEqual(restored.flush(sender, retraction_verified=True), 0)
        self.assertEqual(remote, {'a', 'b'})
        self.assertEqual(calls, ['a', 'a', 'b'])

    def test_chat_prompt_injection_and_legacy_filter(self):
        import chat_engine
        self.client.config['replace_legacy'] = True
        seen = {}
        def generated(*args, **kwargs):
            seen['system'] = args[3]; seen['kwargs'] = kwargs
            yield 'model_round_start', {}
            yield 'delta', '虚构答复'
        with patch.object(bridge, 'for_chat', return_value=self.client), \
             patch.object(chat_engine, 'get_provider', return_value={'base_url': 'http://example.test/v1',
                'api_key': 'synthetic-only', 'format': 'openai', 'id': 1, 'name': 'synthetic'}), \
             patch.object(chat_engine, 'latest_user_text', return_value='虚构问题'), \
             patch.object(chat_engine, 'build_system_sections', return_value={'stable': 'unchanged persona', 'volatile': ''}), \
             patch.object(chat_engine, 'get_conversation_summary', return_value=''), \
             patch.object(chat_engine, 'get_history', return_value=[]), \
             patch.object(chat_engine.tools, 'openai_tools', return_value=[{'function': {'name': 'write_memory'}}]), \
             patch.object(chat_engine, '_run_openai_tool_loop', side_effect=generated):
            list(chat_engine.stream_chat(1, model='synthetic', current_user_message_id=8))
        self.assertIn('serein_live_context', seen['system'])
        self.assertIn('unchanged persona', seen['system'])
        self.assertEqual(seen['kwargs']['base_tool_definitions'], [])


    def test_bound_gateway_refuses_missing_context_without_mcp_fallback(self):
        self.client.config['source_gateway_enabled']=True
        result=self.client.execute('serein_write_scene',{'content':'fiction'},'w','turn')
        self.assertEqual(result['error'],'source_context_incomplete')
        self.mcp.call_tool.assert_not_called()

    def test_basic_scene_writes_preserve_legacy_read_context_and_other_tools(self):
        import chat_engine
        self.client.config['prefer_scene_writes']=True
        self.client.config['replace_legacy']=False
        seen={}
        def generated(*args,**kwargs):
            seen['system']=args[3];seen['tools']=kwargs['base_tool_definitions']
            seen['extra']=kwargs['extra_tools']
            yield 'delta','synthetic answer'
        with patch.object(bridge,'for_chat',return_value=self.client), \
             patch.object(bridge,'suppress_legacy',return_value=False), \
             patch.object(chat_engine,'get_provider',return_value={'base_url':'http://example.test/v1',
                 'api_key':'synthetic-only','format':'openai','id':1,'name':'synthetic'}), \
             patch.object(chat_engine,'latest_user_text',return_value='synthetic question'), \
             patch.object(chat_engine,'build_system_sections',return_value={'stable':'existing persona and legacy memory','volatile':''}), \
             patch.object(chat_engine,'get_conversation_summary',return_value=''), \
             patch.object(chat_engine,'get_history',return_value=[]), \
             patch.object(chat_engine.tools,'openai_tools',return_value=[{'function':{'name':'write_memory'}},{'function':{'name':'read_note'}}]), \
             patch.object(chat_engine,'_run_openai_tool_loop',side_effect=generated):
            list(chat_engine.stream_chat(1,model='synthetic',current_user_message_id=8))
        self.assertIn('existing persona and legacy memory',seen['system'])
        self.assertEqual([item['function']['name'] for item in seen['tools']],['read_note'])
        self.assertTrue(any(item['function']['name']=='serein_write_scene' for item in seen['extra']))

    def test_bound_gateway_timeout_does_not_blindly_repeat_write(self):
        self.client.config['source_gateway_enabled']=True
        context={'instance_id':'synthetic','session_id':1,'sources':[],'epoch':0}
        self.transport.post.side_effect=TimeoutError()
        first=self.client.execute('serein_write_scene',{'content':'fiction'},'w','turn',host_context=context)
        second=self.client.execute('serein_write_scene',{'content':'fiction'},'w','turn',host_context=context)
        self.assertFalse(first['ok']);self.assertFalse(second['ok'])
        self.assertEqual(self.transport.post.call_count,1)
        self.mcp.call_tool.assert_not_called()

    def test_explicit_transactional_rejection_is_not_unknown_write(self):
        self.client.config['source_gateway_enabled']=True
        context={'instance_id':'synthetic','session_id':1,'sources':[],'epoch':0}
        response=self.transport.post.return_value
        response.status_code=409;response.json.return_value={'error':'source_conflict_review_required'}
        for turn in ('first','first','later'):
            result=self.client.execute('serein_write_scene',{'content':'fiction'},'w',turn,host_context=context)
            self.assertEqual(result['error'],'source_write_rejected')
        self.assertEqual(self.transport.post.call_count,2)


class AruTests(unittest.TestCase):
    SAMPLE = '# 虚构会话\n\n## 你 | 2026-10-24T16:00:00+08:00\n虚构问候\n\n---\n\n## 谢亦言 | 2026-10-24T16:00:01+08:00\n虚构回答\n![图](attachments/demo.png)\n'

    def test_roles_times_order_and_missing_attachment(self):
        result = parse_markdown(self.SAMPLE, session_id='synthetic-session')
        self.assertEqual([m['role'] for m in result['messages']], ['user', 'assistant'])
        self.assertEqual(result['messages'][0]['created_at'], '2026-10-24T08:00:00+00:00')
        self.assertEqual(result['messages'][1]['aru']['attachments'][0]['status'], 'not_imported')
        self.assertEqual(result['messages'][1]['aru']['sequence'], 1)

    def test_ids_stable_on_identical_reimport_and_body_edit(self):
        first = parse_markdown(self.SAMPLE, session_id='s')
        again = parse_markdown(self.SAMPLE.replace('虚构问候', '虚构修订'), session_id='s')
        self.assertEqual(first['messages'][0]['id'], again['messages'][0]['id'])
        self.assertNotEqual(first['source_sha256'], again['source_sha256'])

    def test_code_block_header_not_a_message(self):
        text = self.SAMPLE.replace('虚构问候', '```md\n## 你 | 2026-10-24T16:10:00+08:00\n---\n```')
        self.assertEqual(len(parse_markdown(text, session_id='s')['messages']), 2)

    def test_invalid_identity_timezone_and_path(self):
        for text in [self.SAMPLE.replace('谢亦言', '未知角色'),
                     self.SAMPLE.replace('T16:00:00+08:00', 'T16:00:00'),
                     self.SAMPLE.replace('attachments/demo.png', 'attachments/../../secret.png')]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_markdown(text, session_id='s')


class BackupTests(unittest.TestCase):
    def test_encrypted_backup_restores_database_and_config(self):
        from serein_backup import snapshot, restore
        with tempfile.TemporaryDirectory() as work:
            root = Path(work); runtime = root / 'runtime'; runtime.mkdir()
            with sqlite3.connect(runtime / 'synthetic.db') as db:
                db.execute('create table sample(text)'); db.execute("insert into sample values ('fiction only')")
            (runtime / 'config.toml').write_text('synthetic=true')
            encrypted, checksum = snapshot({'runtime': runtime}, root / 'backups', 'synthetic-passphrase-only')
            self.assertEqual(len(checksum), 64)
            self.assertNotIn(b'fiction only', encrypted.read_bytes())
            self.assertEqual(restore(encrypted, root / 'restore', 'synthetic-passphrase-only'), 1)
            with sqlite3.connect(root / 'restore/runtime/synthetic.db') as db:
                self.assertEqual(db.execute('select text from sample').fetchone()[0], 'fiction only')
            with self.assertRaises(ValueError):
                restore(encrypted, root / 'restore', 'synthetic-passphrase-only')
            self.assertEqual([p.suffix for p in (root / 'backups').iterdir()], ['.enc'])

    def test_wrong_password_and_corruption_create_no_restore_target(self):
        from serein_backup import snapshot, restore
        with tempfile.TemporaryDirectory() as work:
            root = Path(work); runtime = root / 'runtime'; runtime.mkdir()
            (runtime / 'config.toml').write_text('synthetic=true')
            encrypted, _ = snapshot({'runtime': runtime}, root / 'backups', 'synthetic-passphrase-only')
            with self.assertRaises(Exception):
                restore(encrypted, root / 'wrong', 'wrong-synthetic-passphrase')
            self.assertFalse((root / 'wrong').exists())
            value = bytearray(encrypted.read_bytes()); value[-1] ^= 1; encrypted.write_bytes(value)
            with self.assertRaises(Exception):
                restore(encrypted, root / 'damaged', 'synthetic-passphrase-only')
            self.assertFalse((root / 'damaged').exists())


if __name__ == '__main__':
    unittest.main()

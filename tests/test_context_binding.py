"""Synthetic host graph export and independent certificate rejection tests."""
from contextlib import closing
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import Mock,patch

import context_binding as binding
import context_provenance as context
import memory_outbox
from source_protocol import SourceConflict,fingerprint


class BindingTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'synthetic.db'
        self.db=context.connect(self.path);self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE sessions(id INTEGER PRIMARY KEY);INSERT INTO sessions VALUES(1);INSERT INTO sessions VALUES(2);
            CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id INTEGER,role TEXT,content TEXT,
              created_at TEXT DEFAULT '2026-01-01T00:00:00Z',active INTEGER DEFAULT 0,hidden INTEGER DEFAULT 0,
              versions TEXT DEFAULT '[]',attachments TEXT DEFAULT '[]',tool_log TEXT DEFAULT '[]',proactive INTEGER DEFAULT 0);
            CREATE TABLE conversation_summaries(session_id INTEGER PRIMARY KEY,summary TEXT,covered_through_message_id INTEGER DEFAULT 0,raw_overlap_count INTEGER DEFAULT 0);
            CREATE TABLE memory_entries(id INTEGER PRIMARY KEY,content TEXT,kind TEXT DEFAULT 'fixed',tags TEXT DEFAULT '[]',pinned INTEGER DEFAULT 0);
            CREATE TABLE persona(id INTEGER PRIMARY KEY,content TEXT);INSERT INTO persona VALUES(1,'Synthetic core');''')
        memory_outbox.initialize(self.db);context.initialize(self.db)
        self.db.execute('UPDATE memory_bridge_control SET enabled=1')
        self.db.execute('UPDATE morrow_context_control SET enabled=1')
        self.db.execute("INSERT INTO messages(id,session_id,role,content) VALUES(1,1,'user','Synthetic copper telescope')")
        self.db.execute("UPDATE memory_bridge_outbox SET state='acknowledged'");self.db.commit()
        self.key='synthetic-private-bridge-credential'
        self.body={'instance_id':self.db.execute('SELECT instance_id FROM memory_bridge_control').fetchone()[0],
            'session_id':1,'epoch':0,'operation_id':'synthetic-write','tool':'write_scene','arguments':{'content':'Fiction','cues':[]},'sources':[]}

    def graph(self,trace):
        trace.record(self.db,'message',1);trace.seal()
        return binding.export(self.path,trace,0)

    def resolver(self,db,instance,session,refs):
        # Unit boundary only; actual archive/epoch/receipt checks are exercised
        # separately against the fixed Serein runtime, not mocked as certified.
        ref=refs[0]
        row=self.db.execute('SELECT * FROM messages WHERE id=? AND session_id=?',(ref['message_id'],session)).fetchone()
        if not row:raise SourceConflict('Missing synthetic source')
        return [{'source_key':json.dumps([instance,session,ref['event_id']]),'content':row['content'],
                 'metadata':{'role':row['role'],'created_at':'2026-01-01T00:00:00+00:00'}}]

    def sign(self,graph,**kwargs):
        return binding.sign(graph,self.key,self.body['operation_id'],self.body['tool'],self.body['arguments'],**kwargs)

    def verify(self,certificate,**kwargs):
        return binding.verify(self.db,certificate,self.key,self.body,self.resolver,**kwargs)

    def test_primary_graph_requires_both_signature_and_resolution(self):
        with context.generation(self.path,1) as trace:
            graph=self.graph(trace)
            resolved,stamp=self.verify(self.sign(graph))
            self.assertEqual(len(resolved),1);self.assertEqual(len(stamp),64)
            self.assertNotIn('certified',graph)

    def test_wrong_key_and_mutated_signature_rejected(self):
        with context.generation(self.path,1) as trace:
            graph=self.graph(trace);certificate=self.sign(graph)
            certificate['signature']='0'*64
            with self.assertRaises(SourceConflict):self.verify(certificate)
            certificate=binding.sign(graph,'other-synthetic-key',self.body['operation_id'],self.body['tool'],self.body['arguments'])
            with self.assertRaises(SourceConflict):self.verify(certificate)

    def test_certificate_bound_to_operation_arguments_and_epoch(self):
        with context.generation(self.path,1) as trace:
            certificate=self.sign(self.graph(trace))
            for field,value in [('operation_id','different'),('epoch',1),('session_id',2),('arguments',{'content':'Different'})]:
                old=self.body[field];self.body[field]=value
                with self.assertRaises(SourceConflict):self.verify(certificate)
                self.body[field]=old

    def test_expired_or_future_certificate_rejected(self):
        with context.generation(self.path,1) as trace:
            certificate=self.sign(self.graph(trace),now=100)
            for now in (97,131):
                with self.assertRaises(SourceConflict):self.verify(certificate,now=now)

    def test_signed_complete_does_not_bypass_unknown_dependency(self):
        with context.generation(self.path,1) as trace:
            graph=self.graph(trace);graph['nodes'][0]['payload']['unknown']=['legacy']
            graph['nodes'][0]['digest']=context.digest(graph['nodes'][0]['payload'])
            with self.assertRaises(SourceConflict):self.verify(self.sign(graph))

    def test_rehashed_forged_quote_rejected_by_source_hash(self):
        with context.generation(self.path,1) as trace:
            graph=self.graph(trace);obj=graph['objects'][0];obj['snapshot']['content']='Invented'
            obj['hash']=context.digest(obj['snapshot'])
            node=graph['nodes'][0];node['payload']['dependencies'][0]['hash']=obj['hash'];node['digest']=context.digest(node['payload'])
            with self.assertRaises(SourceConflict):self.verify(self.sign(graph))

    def test_missing_or_extra_graph_object_rejected(self):
        with context.generation(self.path,1) as trace:
            graph=self.graph(trace)
            for changed in [[],graph['objects']+[deepcopy(graph['objects'][0])]]:
                candidate=deepcopy(graph);candidate['objects']=changed
                with self.assertRaises(SourceConflict):self.verify(self.sign(candidate))

    def test_dangling_or_cyclic_parent_rejected(self):
        with context.generation(self.path,1) as trace:
            graph=self.graph(trace)
            for identifier in ('missing',graph['root']):
                candidate=deepcopy(graph);node=candidate['nodes'][0]
                node['payload']['dependencies'][0]['manifest']=identifier
                node['digest']=context.digest(node['payload'])
                candidate['objects'][0]['manifest']=identifier
                with self.assertRaises(SourceConflict):self.verify(self.sign(candidate))

    def test_pending_or_quarantined_host_cannot_export(self):
        with context.generation(self.path,1) as trace:
            self.graph(trace)
            self.db.execute("UPDATE memory_bridge_outbox SET state='pending'");self.db.commit()
            with self.assertRaises(ValueError):binding.export(self.path,trace,0)
            self.db.execute('UPDATE memory_bridge_control SET recall_blocked=1');self.db.commit()
            self.assertIsNone(binding.export(self.path,trace,0))

    def test_old_unknown_summary_cannot_export(self):
        with self.db:
            self.db.execute('UPDATE morrow_context_control SET enabled=0')
            self.db.execute("INSERT INTO conversation_summaries VALUES(1,'Unknown old summary',1,0)")
            self.db.execute('UPDATE morrow_context_control SET enabled=1')
        with context.generation(self.path,1) as trace:
            trace.record(self.db,'summary',1)
            self.assertIsNone(self.graph(trace))

    def test_proven_summary_and_cross_session_message_include_all_leaves(self):
        with context.generation(self.path,1,'summary') as trace:
            self.graph(trace)
            self.db.execute("INSERT INTO conversation_summaries VALUES(1,'Synthetic derived summary',1,0)")
            context.bind(self.db,'summary',1);self.db.commit()
        with context.generation(self.path,2) as trace:
            trace.record(self.db,'summary',1);trace.seal()
            graph=binding.export(self.path,trace,0)
            self.body['session_id']=2
            resolved,_=self.verify(self.sign(graph))
            self.assertEqual(len(resolved),1)
            self.assertEqual({o['kind'] for o in graph['objects']},{'summary','message'})

    def test_edited_source_invalidates_export_even_when_restored_text_matches(self):
        with context.generation(self.path,1) as trace:
            self.graph(trace)
            self.db.execute("UPDATE messages SET active=1,versions=? WHERE id=1",(json.dumps([{},{}]),));self.db.commit()
            self.assertIsNone(binding.export(self.path,trace,0))

    def test_media_and_tool_results_cannot_be_signed_as_complete(self):
        for reason in ('media_without_manifest','tool_result_without_manifest','external_memory_without_manifest'):
            with context.generation(self.path,1) as trace:
                trace.opaque(reason);self.assertIsNone(self.graph(trace))

    def test_owner_assertion_is_distinct_from_original_quote(self):
        with context.owner(),self.db:self.db.execute("INSERT INTO memory_entries(id,content) VALUES(1,'Owner assertion')")
        with context.generation(self.path,1) as trace:
            trace.record(self.db,'memory',1);graph=self.graph(trace)
            self.verify(self.sign(graph))
            obj=next(o for o in graph['objects'] if o['kind']=='memory')
            self.assertEqual(obj['origin'],'owner_assertion_not_message_quote')

    def test_memory_outbox_exports_current_trace_not_recent_records_only(self):
        with context.generation(self.path,1) as trace:
            trace.record(self.db,'message',1)
            result=memory_outbox.source_context(self.path,1,[{'id':1,'content':'Synthetic copper telescope','active':0}],0,trace=trace)
            self.assertEqual(result['sources'],[]);self.assertIn('context_graph',result)

    def test_bridge_requires_matching_receiver_context_receipt(self):
        import serein_bridge
        root=Path(self.tmp.name);token=root/'token';token.write_text(self.key)
        transport=Mock();transport.post.return_value.status_code=200
        client=serein_bridge.Bridge({'base_url':'http://127.0.0.1:8011','token_file':str(token),
            'ledger':str(root/'ledger.db'),'instance_id':'synthetic','tools_enabled':True,'source_gateway_enabled':True},transport,Mock())
        transport.post.return_value.json.return_value={'ok':True,'id':'synthetic-scene','content':'saved'}
        with context.generation(self.path,1) as trace:
            graph=self.graph(trace)
            result=client.execute('serein_write_scene',self.body['arguments'],'window','turn',host_context={
                'instance_id':graph['instance_id'],'session_id':1,'epoch':0,'sources':[],'context_graph':graph})
            self.assertFalse(result['ok'])
            # Missing response proof is UNKNOWN, never automatically retried.
            again=client.execute('serein_write_scene',self.body['arguments'],'window','turn',host_context={
                'instance_id':graph['instance_id'],'session_id':1,'epoch':0,'sources':[],'context_graph':graph})
            self.assertFalse(again['ok']);self.assertEqual(transport.post.call_count,1)

    def test_owner_review_of_old_summary_is_explicit_assertion_not_quote(self):
        with context.owner(),self.db:self.db.execute("INSERT INTO conversation_summaries VALUES(1,'Reviewed owner assertion',1,0)")
        with context.generation(self.path,1) as trace:
            trace.record(self.db,'summary',1);graph=self.graph(trace)
            self.verify(self.sign(graph))
            self.assertEqual(next(o for o in graph['objects'] if o['kind']=='summary')['origin'],
                             'owner_assertion_not_message_quote')

    def test_generic_mcp_alias_cannot_bypass_context_bound_writer(self):
        import tools
        with patch.object(tools,'_find_mcp_tool',return_value=({'name':'Synthetic Serein alias'}, {'name':'write_scene'})), \
             patch.object(tools.mcp_client,'call_tool') as call, context.generation(self.path,1):
            result=tools.execute('mcp_synthetic_alias',{'content':'Unbound'},1)
            self.assertFalse(result['ok']);self.assertEqual(result['error'],'external_tool_context_unverified')
            call.assert_not_called()

    def test_host_edit_during_remote_commit_is_not_reported_as_success(self):
        import serein_bridge
        root=Path(self.tmp.name);token=root/'token';token.write_text(self.key)
        transport=Mock();transport.post.return_value.status_code=200
        client=serein_bridge.Bridge({'base_url':'http://127.0.0.1:8011','token_file':str(token),
            'ledger':str(root/'ledger-postcheck.db'),'instance_id':'synthetic','tools_enabled':True,'source_gateway_enabled':True},transport,Mock())
        def response():
            certificate=transport.post.call_args.kwargs['json']['context_certificate']
            with self.db:self.db.execute("UPDATE messages SET content='Concurrent owner correction' WHERE id=1")
            return {'ok':True,'id':'synthetic-committed-scene','content':'saved','context_verification':{
                'version':binding.VERSION,'digest':fingerprint(certificate['payload']),'epoch':0}}
        transport.post.return_value.json.side_effect=response
        with context.generation(self.path,1) as trace:
            graph=self.graph(trace)
            result=client.execute('serein_write_scene',self.body['arguments'],'w','t',host_context={
                'instance_id':graph['instance_id'],'session_id':1,'epoch':0,'sources':[],'context_graph':graph})
            self.assertFalse(result['ok'])
            self.assertEqual(self.db.execute('SELECT recall_blocked FROM memory_bridge_control').fetchone()[0],1)

    def test_signed_graph_cannot_relabel_unknown_status_as_complete(self):
        with context.generation(self.path,1) as trace:
            graph=self.graph(trace);node=graph['nodes'][0]
            node['payload']['dependencies'][0]['status']='unknown'
            node['digest']=context.digest(node['payload'])
            with self.assertRaises(SourceConflict):self.verify(self.sign(graph))

    def test_rehashed_timestamp_cannot_disagree_with_archived_message(self):
        with context.generation(self.path,1) as trace:
            graph=self.graph(trace);obj=graph['objects'][0]
            obj['snapshot']['created_at']='2025-01-01T00:00:00Z'
            obj['hash']=context.digest(obj['snapshot']);node=graph['nodes'][0]
            node['payload']['dependencies'][0]['hash']=obj['hash'];node['digest']=context.digest(node['payload'])
            with self.assertRaises(SourceConflict):self.verify(self.sign(graph))

    def test_owner_memory_correction_blocks_external_recall_until_reconciled(self):
        with context.owner(),self.db:
            self.db.execute("INSERT INTO memory_entries(id,content) VALUES(1,'Owner assertion')")
            self.db.execute("UPDATE memory_entries SET content='Owner correction' WHERE id=1")
        self.assertTrue(memory_outbox.quarantine(self.path))
        self.assertTrue(context.readable(self.db,'memory',1))

    def test_write_identity_survives_trace_restart_but_changes_with_epoch(self):
        import serein_bridge
        root=Path(self.tmp.name);token=root/'token';token.write_text(self.key)
        transport=Mock();transport.post.return_value.status_code=200
        client=serein_bridge.Bridge({'base_url':'http://127.0.0.1:8011','token_file':str(token),
            'ledger':str(root/'ledger-identities.db'),'instance_id':'synthetic','tools_enabled':True,'source_gateway_enabled':True},transport,Mock())
        def response():
            posted=transport.post.call_args.kwargs['json'];certificate=posted['context_certificate']
            return {'ok':True,'id':'synthetic-scene','content':'saved','context_verification':{
                'version':binding.VERSION,'digest':fingerprint(certificate['payload']),'epoch':posted['epoch']}}
        transport.post.return_value.json.side_effect=response
        identifiers=[]
        for epoch in (0,0,1):
            with context.generation(self.path,1) as trace:
                graph=self.graph(trace);graph['epoch']=epoch
                result=client.execute('serein_write_scene',self.body['arguments'],'w','same-turn',host_context={
                    'instance_id':graph['instance_id'],'session_id':1,'epoch':epoch,'sources':[],'context_graph':graph})
                self.assertTrue(result['ok'])
                identifiers.append(transport.post.call_args.kwargs['json']['operation_id'])
        self.assertEqual(identifiers[0],identifiers[1]);self.assertNotEqual(identifiers[1],identifiers[2])
        self.assertEqual(transport.post.call_count,2)


if __name__=='__main__':unittest.main()

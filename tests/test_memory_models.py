import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from functools import wraps
from unittest.mock import Mock, patch

from flask import Flask, g, request
import memory_models as models
import memory_outbox


class MemoryModelsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'state.db'
        with sqlite3.connect(self.path) as db:
            db.executescript('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE providers(id INTEGER PRIMARY KEY,name TEXT,api_url TEXT,api_key TEXT,format TEXT,models TEXT,sort_order INTEGER);')
            db.execute('INSERT INTO providers VALUES (1,?,?,?,?,?,0)',
                ('synthetic','https://models.example.test/v1','private-synthetic-value','openai',json.dumps([{'id':'embed'},{'id':'rank'}])))
        self.web = Flask(__name__); self.web.secret_key='synthetic-only'
        def get_db():
            if 'db' not in g:
                g.db=sqlite3.connect(self.path);g.db.row_factory=sqlite3.Row
            return g.db
        @self.web.teardown_appcontext
        def close(error):
            if 'db' in g:g.db.close()
        def auth(fn):
            @wraps(fn)
            def wrapped(*args,**kwargs):
                if request.headers.get('X-Synthetic-Auth')!='yes':return {'error':'unauthorized'},401
                return fn(*args,**kwargs)
            return wrapped
        models.register(self.web,get_db,auth,broker_secret='synthetic-broker')
        self.client=self.web.test_client(); self.headers={'X-Synthetic-Auth':'yes'}

    def save(self):
        return self.client.put('/api/memory/models',json={'revision':0,
            'embedding':{'provider_id':1,'model_id':'embed'},'reranker':{'provider_id':1,'model_id':'rank'}},headers=self.headers)

    def test_auth_and_no_credentials_in_selection_api(self):
        self.assertEqual(self.client.get('/api/memory/models').status_code,401)
        response=self.client.get('/api/memory/models',headers=self.headers)
        self.assertNotIn('private-synthetic-value',response.get_data(as_text=True))
        self.assertNotIn('api_key',response.get_data(as_text=True))

    def test_selection_cas_origin_and_no_key_fields(self):
        self.assertEqual(self.save().status_code,200)
        self.assertEqual(self.save().status_code,409)
        self.assertEqual(self.client.put('/api/memory/models',json={'revision':1,'api_key':'no'},headers=self.headers).status_code,400)
        self.assertEqual(self.client.put('/api/memory/models',json={'revision':1},headers={**self.headers,'Origin':'https://evil.example'}).status_code,403)

    def test_https_proxy_origin_is_supported(self):
        result=self.client.put('/api/memory/models',json={'revision':0,'embedding':None,'reranker':None},
            headers={**self.headers,'Origin':'https://localhost','X-Forwarded-Proto':'https'})
        self.assertEqual(result.status_code,200)

    def test_invalid_provider_or_model_rejected(self):
        for selection in [{'provider_id':2,'model_id':'embed'},{'provider_id':1,'model_id':'missing'},{'provider_id':[], 'model_id':'embed'}]:
            response=self.client.put('/api/memory/models',json={'revision':0,'embedding':selection,'reranker':None},headers=self.headers)
            self.assertEqual(response.status_code,400)

    def test_validation_broker_and_rotation(self):
        self.save()
        reply=Mock(status_code=200);reply.json.return_value={'model':'embed','data':[{'index':0,'embedding':[1.,0.]}], 'api_key':'must-not-forward'}
        with patch.object(models.requests,'Session') as factory:
            factory.return_value.post.return_value=reply
            validated=self.client.post('/api/memory/models/validate',json={'role':'embedding'},headers=self.headers)
            self.assertEqual(validated.json['validation']['embedding']['status'],'verified')
            self.assertNotIn('private-synthetic-value',validated.get_data(as_text=True))
            payload={'model':'embed','input':['fiction only']}
            self.assertEqual(self.client.post('/internal/memory-models/embeddings',json=payload).status_code,401)
            result=self.client.post('/internal/memory-models/embeddings',json=payload,headers={'Authorization':'Bearer synthetic-broker'})
            self.assertEqual(result.status_code,200)
            self.assertNotIn('api_key',result.get_data(as_text=True))
        with sqlite3.connect(self.path) as db:db.execute("UPDATE providers SET api_key='new-synthetic-value'")
        state=self.client.get('/api/memory/models',headers=self.headers).json
        self.assertEqual(state['validation']['embedding']['status'],'pending')
        self.assertEqual(self.client.post('/internal/memory-models/embeddings',json=payload,headers={'Authorization':'Bearer synthetic-broker'}).status_code,409)

    def test_failed_validation_and_timeout_do_not_claim_ready(self):
        self.save()
        with patch.object(models.requests,'Session') as factory:
            factory.return_value.post.side_effect=models.requests.Timeout()
            result=self.client.post('/api/memory/models/validate',json={'role':'embedding'},headers=self.headers)
        self.assertEqual(result.status_code,200)
        self.assertFalse(result.json['models_ready'])
        self.assertEqual(result.json['validation']['embedding']['status'],'incompatible_or_unavailable')

    def test_budget_rejects_before_provider_request(self):
        self.save()
        with sqlite3.connect(self.path) as db:
            db.row_factory=sqlite3.Row
            with patch.object(models,'DAILY_CALLS',0),patch.object(models.requests,'Session') as factory:
                with self.assertRaises(models.ModelError):models.provider_request(db,'embedding',{'model':'embed','input':['synthetic']})
                factory.assert_not_called()

    def test_reranker_requires_actual_scores_not_vectors(self):
        self.save()
        reply=Mock(status_code=200);reply.json.return_value={'data':[{'embedding':[1.,0.]}]}
        with patch.object(models.requests,'Session') as factory:
            factory.return_value.post.return_value=reply
            result=self.client.post('/api/memory/models/validate',json={'role':'reranker'},headers=self.headers)
        self.assertFalse(result.json['models_ready'])
        self.assertEqual(result.json['validation']['reranker']['status'],'incompatible_or_unavailable')

    def test_existing_provider_api_redacts_key(self):
        import app
        with sqlite3.connect(self.path) as db:
            db.row_factory=sqlite3.Row
            row=dict(db.execute('select * from providers').fetchone());row.update(cache=0,cache_mode='none')
            output=app._provider_dict(row)
            self.assertEqual(output['api_key'],'');self.assertTrue(output['api_key_configured'])

    def test_broker_generation_changes_when_underlying_provider_changes(self):
        self.save();headers={'Authorization':'Bearer synthetic-broker'}
        first=self.client.get('/internal/memory-models/config',headers=headers).json
        with sqlite3.connect(self.path) as db:db.execute("UPDATE providers SET api_url='https://other.example.test/v1'")
        second=self.client.get('/internal/memory-models/config',headers=headers).json
        self.assertNotEqual(first['embedding']['generation'],second['embedding']['generation'])
        self.assertNotIn('private-synthetic-value',json.dumps(second))

    def test_provider_metadata_edit_with_empty_key_preserves_stored_key(self):
        import app
        db=Mock()
        old={'api_key':'private-synthetic-value'}
        updated={'id':1,'name':'renamed','format':'openai','api_key':'private-synthetic-value',
                 'api_url':'https://models.example.test/v1','cache':0,'cache_mode':'none','models':'[]'}
        db.execute.return_value.fetchone.side_effect=[old,updated]
        with app.app.test_client() as client:
            with client.session_transaction() as state:state['authed']=True
            with patch.object(app,'get_db',return_value=db),patch.object(models,'load',return_value={'embedding':None,'reranker':None}):
                result=client.put('/api/providers/1',json={'name':'renamed','api_key':'','api_url':'https://models.example.test/v1'})
        self.assertEqual(result.status_code,200)
        write=next(call for call in db.execute.call_args_list if 'UPDATE providers' in call.args[0])
        self.assertEqual(write.args[1][2],'private-synthetic-value')
        self.assertNotIn('private-synthetic-value',result.get_data(as_text=True))


class TransactionalOutboxTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'synthetic.db'
        self.db=sqlite3.connect(self.path);self.db.row_factory=sqlite3.Row;self.addCleanup(self.db.close)
        self.db.executescript('''PRAGMA foreign_keys=ON;
            CREATE TABLE sessions(id INTEGER PRIMARY KEY);
            CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,role TEXT,content TEXT,created_at TEXT,versions TEXT DEFAULT '[]',active INTEGER DEFAULT 0,hidden INTEGER DEFAULT 0,attachments TEXT DEFAULT '[]');
            INSERT INTO sessions VALUES(1);''')
        memory_outbox.initialize(self.db)

    def add(self):
        self.db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES(1,'user','fiction','2026-01-01T00:00:00Z')")

    def count(self):return self.db.execute('select count(*) from memory_bridge_outbox').fetchone()[0]

    def enable_fixture(self):
        self.db.execute('UPDATE memory_bridge_control SET enabled=1');self.db.commit()

    def test_default_off_and_repeat_initialization_preserves_control(self):
        self.add();self.db.commit();self.assertEqual(self.count(),0)
        old=self.db.execute('select instance_id from memory_bridge_control').fetchone()[0]
        memory_outbox.initialize(self.db)
        self.assertEqual(old,self.db.execute('select instance_id from memory_bridge_control').fetchone()[0])

    def test_rollback_is_atomic(self):
        self.enable_fixture();self.add();self.assertEqual(self.count(),1)
        self.db.rollback();self.assertEqual(self.count(),0)

    def test_all_message_mutations_and_session_cascade_captured(self):
        self.enable_fixture();self.add()
        self.db.execute("UPDATE messages SET content='fiction edited' WHERE id=1")
        self.db.execute("UPDATE messages SET active=1,versions='[{\"c\":\"old\"},{\"c\":\"fiction edited\"}]' WHERE id=1")
        self.db.execute('DELETE FROM sessions WHERE id=1');self.db.commit()
        rows=self.db.execute('select * from memory_bridge_outbox order by sequence').fetchall()
        self.assertEqual([r['kind'] for r in rows],['upsert','upsert','upsert','withdraw','withdraw_session'])
        self.assertEqual(len({r['event_id'] for r in rows}),5)
        self.assertTrue(memory_outbox.quarantine(self.path))

    def test_restart_lost_ack_retry_and_quarantine_not_automatically_cleared(self):
        self.enable_fixture();self.add();self.db.commit()
        remote=set();calls=[]
        def send(event):
            calls.append(event['event_id'])
            if event['event_id'] not in remote:
                remote.add(event['event_id']);raise TimeoutError()
            return {'event_id':event['event_id'],'state':'applied'}
        with patch('serein_bridge.SOURCE_RETRACTION_VERIFIED',True):
            self.assertEqual(memory_outbox.drain(self.path,send)['status'],'retry_pending')
            self.assertEqual(memory_outbox.drain(self.path,send)['acknowledged'],1)
        self.assertEqual(len(calls),2);self.assertEqual(len(remote),1)

    def test_production_hard_gate_never_calls_sender(self):
        self.enable_fixture();self.add();self.db.commit();send=Mock()
        self.assertEqual(memory_outbox.drain(self.path,send)['status'],'disabled_unverified_withdrawal')
        send.assert_not_called()


if __name__=='__main__':unittest.main()

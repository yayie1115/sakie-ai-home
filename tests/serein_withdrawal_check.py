"""Opt-in pinned-runtime integration; fresh synthetic databases, no model calls."""
import asyncio
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import subprocess
from concurrent.futures import ThreadPoolExecutor
import os
import socket
import time
import urllib.request

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from serein.config import Settings
from serein.bootstrap import initialize
from serein.deployment import save_settings
from serein.core.store import Store, encode
from serein.core.reader import Reader
from serein.compat.events import Events, project_events
from serein.recall.index import build_index, Search
from serein_source_projection import Projector
from serein_source_receiver import author_scene
from serein_source_host import create_guarded_app
import serein_source_guard as guard
import source_protocol as protocol


def main():
    passed=[]
    with tempfile.TemporaryDirectory(prefix='morrow-withdrawal-synthetic-') as directory:
        root=Path(directory)
        settings=Settings(root/'synthetic.db',index=root/'index.db',writable=True)
        initialize(settings);save_settings(settings.database,{'pipeline':{'auto_enabled':False}})
        projector=Projector(settings)
        with Store(settings.database) as store:
            store.create('unrelated-scene','scene','Unrelated fictional memory','A red kite on a hill')
        instance='synthetic-instance'
        def event(key,text='Fictional copper compass in observatory',kind='upsert',mid=1,session=1,active=0):
            head=projector.head(instance)
            return protocol.envelope({'event_id':key,'instance_id':instance,'kind':kind,
                'message_id':None if kind=='withdraw_session' else mid,'session_id':session,
                'message':{'role':'user','text':text,'created_at':'2026-01-01T00:00:00Z',
                           'active':active,'hidden':0,'partial':0}},head['sequence']+1,head['sequence'],head['hash'])
        first=event('original');projector.apply(first)
        ref={'message_id':1,'event_id':'original','version':0,
             'content_hash':hashlib.sha256(first['message']['text'].encode()).hexdigest()}
        request={'instance_id':instance,'session_id':1,'operation_id':'scene-operation','tool':'write_scene',
                 'arguments':{'content':'A fictional subjective recollection of a copper compass.','cues':['copper compass']},
                 'sources':[ref],'epoch':guard.current(settings.database)}
        scene=author_scene(settings,request)
        assert author_scene(settings,request)==scene
        passed.append('scene_atomic_idempotency')
        with Reader(settings.database) as reader:
            obj=reader.read(scene['id']);assert obj['readable']
            assert obj['evidence'][0]['metadata']['host_version']==0
            assert obj['evidence'][0]['metadata']['scope']=='context_dependency_not_factual_support'
        passed.append('trusted_host_version_and_context_scope')
        with Store(settings.database) as store:
            original_json=store.conn.execute("SELECT original_json FROM morrow_source_versions WHERE event_id='original'").fetchone()[0]
            store.conn.execute("UPDATE morrow_source_versions SET original_json='{}' WHERE event_id='original'")
        try:author_scene(settings,{**request,'operation_id':'bad-receipt'});raise AssertionError('receipt integrity ignored')
        except protocol.SourceConflict:pass
        with Store(settings.database) as store:
            store.conn.execute("UPDATE morrow_source_versions SET original_json=? WHERE event_id='original'",(original_json,))
        with Reader(settings.database) as reader:stamp=reader.read(scene['id'])['document']['updated_at']
        edit={**request,'operation_id':'scene-edit','tool':'edit_scene','arguments':{
            'scene_id':scene['id'],'expected_updated_at':stamp,'content':'A revised subjective synthetic impression.'}}
        assert author_scene(settings,edit)['revision']==2
        try:author_scene(settings,{**edit,'operation_id':'stale-edit'});raise AssertionError('stale edit accepted')
        except protocol.SourceConflict:pass
        passed.append('bound_scene_edit_and_stale_cas')
        for change in [{'sources':[{**ref,'content_hash':'f'*64}]},
                       {'sources':[{**ref,'quote':'invented'}]}, {'session_id':2},
                       {'arguments':{**request['arguments'],'evidence_refs':[]}}]:
            try:author_scene(settings,{**request,**change});raise AssertionError('forged source accepted')
            except (ValueError,protocol.SourceConflict):pass
        passed.append('model_evidence_spoofing_and_cross_session_rejected')
        evidence={'source_system':'morrow:'+instance,'session_id':'1','message_id':'original','role':'user',
                  'created_at':'2026-01-01T00:00:00Z','content':first['message']['text'],
                  'binding_method':'archive_pipeline','evidence_kind':'primary'}
        saved=Events(settings.database).settle('synthetic-event-operation',[{
            'type':'event','title':'Fictional compass event','body':'A copper compass was placed in the observatory.',
            'source_refs':[evidence],'recallable':True}])
        event_id=saved['items'][0]['item_id']
        with Store(settings.database) as store:
            store.create('dependent-narrative','narrative','Synthetic arc','An arc about the copper compass',
                         metadata={'arc_key':'synthetic-arc'})
            store.conn.execute('INSERT INTO event_arc_links VALUES (?,?,?,?)',('synthetic-arc',event_id,'synthetic','{}'))
            store.conn.execute("INSERT INTO pipeline_batches(id,scope,input_json,status) VALUES('old-batch','synthetic','{}','pending')")
            store.conn.execute("INSERT INTO pipeline_jobs(id,batch_id,role,request_json) VALUES('old-job','old-batch','synthetic','{}')")
        old_epoch=guard.current(settings.database)
        # Build an intentionally stale physical index, then revoke without
        # refreshing it. Readability/stamp checks must prevent index resurrection.
        stale=root/'stale-index.db';build_index(settings.database,stale)
        changed=event('edited',text='Fictional compass was moved to the greenhouse',active=1)
        projector.apply(changed)
        assert projector.apply(changed)==protocol.acknowledgement(changed)
        passed.append('edit_and_lost_ack_replay')
        with Reader(settings.database) as reader:
            for key in [scene['id'],event_id,'dependent-narrative']:
                assert not reader.read(key)['readable']
                assert not reader.read(key,revision=1)['readable']
            assert reader.read('unrelated-scene')['readable']
        passed.append('source_edit_invalidates_scene_event_history_not_unrelated_memory')
        shadow=Events(settings.database).read_many([event_id])['items'][0]
        assert shadow['status']=='tombstoned' and not shadow['body'] and not shadow['source_refs']
        passed.append('shadow_event_reads_redacted')
        with Store(settings.database) as store,store.transaction(immediate=True):
            project_events(store.conn)
        with Reader(settings.database) as reader:assert not reader.read(event_id)['readable']
        passed.append('native_reprojection_cannot_restore_withdrawn_event')
        with Search(settings.database,stale) as search:
            result=search.search('copper compass')
            assert scene['id'] not in json.dumps(result) and event_id not in json.dumps(result)
            assert 'A revised subjective synthetic impression.' not in json.dumps(result)
            assert 'A copper compass was placed in the observatory.' not in json.dumps(result)
        passed.append('stale_physical_index_cannot_expose_withdrawn_documents')
        for sql,args in [("UPDATE fact_events SET status='active' WHERE item_id=?",(event_id,)),
                         ("UPDATE documents SET lifecycle='active' WHERE id=?",(scene['id'],)),
                         ("UPDATE pipeline_jobs SET output_json='{}' WHERE id='old-job'",()),
                         ("UPDATE pipeline_batches SET status='pending' WHERE id='old-batch'",()),
                         ("INSERT INTO raw_processing VALUES(999,'old-batch','settled')",())]:
            try:
                with Store(settings.database) as store,store.transaction(immediate=True):store.conn.execute(sql,args)
                raise AssertionError('revoked state restored')
            except sqlite3.IntegrityError:pass
        passed.append('frozen_outputs_empty_settlements_and_restores_blocked')
        try:
            with guard.scope(settings.database,old_epoch):
                Events(settings.database).settle('late-independent-id',[{'type':'event','title':'Old result',
                    'body':'Old source result','source_refs':[evidence],'recallable':True}])
            raise AssertionError('old asynchronous task committed')
        except (sqlite3.IntegrityError,protocol.SourceConflict,ValueError):pass
        current_evidence={**evidence,'message_id':'edited','content':changed['message']['text']}
        try:
            with guard.scope(settings.database,old_epoch):
                Events(settings.database).settle('late-id-current-reference',[{'type':'event','title':'Late result',
                    'body':'Stale output with a newly known reference','source_refs':[current_evidence],'recallable':True}])
            raise AssertionError('nested settle refreshed an old context epoch')
        except sqlite3.IntegrityError:pass
        passed.append('old_operation_context_cannot_commit_after_epoch_change')
        try:author_scene(settings,request);raise AssertionError('revoked context used')
        except protocol.SourceConflict:passed.append('old_scene_write_cannot_retry_after_source_edit')
        # A fresh task cannot invent a reference to the withdrawn source either.
        try:
            Events(settings.database).settle('fresh-id-old-source',[{'type':'event','title':'Bad reuse','body':'Old source',
                'source_refs':[evidence],'recallable':True}]);raise AssertionError('old source reused')
        except (sqlite3.IntegrityError,ValueError):passed.append('fresh_task_cannot_reuse_revoked_shadow_source')
        from serein.extensions import pipeline
        try:
            asyncio.run(pipeline.job(settings.database,{'id':'old-batch'},{},'late',None))
            raise AssertionError('frozen job resumed')
        except protocol.SourceConflict:passed.append('native_pipeline_job_rejects_frozen_epoch_before_model')
        raced=event('concurrent-edit',text='Fictional compass is now in a blue locker',active=2)
        async def concurrent():
            started=asyncio.Event();released=asyncio.Event()
            async def old_task():
                with guard.scope(settings.database):
                    started.set();await released.wait()
                    try:
                        with Store(settings.database) as store:
                            store.create('late-scene','scene','Stale asynchronous output','Old synthetic text')
                    except sqlite3.IntegrityError:return
                    raise AssertionError('inflight stale write committed')
            task=asyncio.create_task(old_task());await started.wait()
            await asyncio.to_thread(projector.apply,raced)
            released.set();await task
        asyncio.run(concurrent());changed=raced
        passed.append('actual_async_context_and_concurrent_withdrawal_barrier')
        current_ref={**ref,'event_id':'edited','version':1,
                     'content_hash':hashlib.sha256(changed['message']['text'].encode()).hexdigest()}
        current_ref.update(event_id='concurrent-edit',version=2)
        fresh_request={**request,'operation_id':'new-scene','sources':[current_ref],'epoch':guard.current(settings.database)}
        fresh=author_scene(settings,fresh_request)
        with Reader(settings.database) as reader:assert reader.read(fresh['id'])['readable']
        passed.append('new_epoch_accepts_fresh_verified_scene')
        try:
            from serein.compat.scenes import Scenes
            Scenes(settings.database).write('Unbound bypass attempt',['bypass'])
            raise AssertionError('native unbound Scene bypassed trusted host route')
        except sqlite3.IntegrityError:passed.append('native_unbound_scene_publisher_cannot_bypass_host')
        snapshot=sqlite3.connect(':memory:')
        with Store(settings.database) as store:store.conn.backup(snapshot)
        deleted=event('delete-session',kind='withdraw_session');projector.apply(deleted)
        with Reader(settings.database) as reader:assert not reader.read(fresh['id'])['readable']
        projector=Projector(settings);assert projector.apply(deleted)==protocol.acknowledgement(deleted)
        passed.append('session_delete_and_receiver_restart')
        # Restore only the synthetic database; replay exact stable event safely.
        with Store(settings.database) as store:snapshot.backup(store.conn)
        snapshot.close();projector=Projector(settings);projector.apply(deleted)
        with Reader(settings.database) as reader:assert not reader.read(fresh['id'])['readable']
        passed.append('restored_snapshot_replays_withdrawal')
        with Store(settings.database) as store:
            assert store.conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
            assert not store.conn.execute('PRAGMA foreign_key_check').fetchall()
        passed.append('integrity_and_foreign_keys')
        # Real ASGI routes, not a fake HTTP sender. All credentials/content here
        # are synthetic and no live provider or production host is contacted.
        from fastapi.testclient import TestClient
        policy=root/'policy.json';policy.write_text(json.dumps({'enabled':False,'instance_id':instance,'release':guard.VERSION}))
        app=create_guarded_app(settings,'synthetic-receiver-only',policy)
        headers={'Authorization':'Bearer synthetic-receiver-only'}
        with TestClient(app) as client:
            assert client.post('/bridge/capabilities',json={}).status_code==401
            caps=client.post('/bridge/capabilities',json={},headers=headers)
            assert caps.status_code==200 and caps.json()['source_enabled'] is False
            assert client.post('/bridge/source-status',json={'instance_id':instance},headers=headers).status_code==503
            passed.append('receiver_closed_by_default_and_authenticated')
            policy.write_text(json.dumps({'enabled':True,'instance_id':instance,'release':guard.VERSION}))
            assert client.post('/bridge/source-status',json={'instance_id':'other'},headers=headers).status_code==403
            status=client.post('/bridge/source-status',json={'instance_id':instance},headers=headers)
            assert status.status_code==200 and status.json()['sequence']==projector.head(instance)['sequence']
            assert client.post('/bridge/source-events',json=deleted,headers=headers).json()==protocol.acknowledgement(deleted)
            wrong={**deleted,'message':{**deleted['message'],'text':'conflict'}}
            assert client.post('/bridge/source-events',json=wrong,headers=headers).status_code==409
            assert client.post('/bridge/source-events',json=deleted,headers={**headers,'Origin':'https://example.test'}).status_code==401
            passed.append('receiver_instance_order_conflict_origin_and_durable_ack')
            submitted=event('http-original',mid=7)
            sent=client.post('/bridge/source-events',json=submitted,headers=headers)
            assert sent.status_code==200 and sent.json()==protocol.acknowledgement(submitted)
            source={'message_id':7,'event_id':'http-original','version':0,
                    'content_hash':hashlib.sha256(submitted['message']['text'].encode()).hexdigest()}
            http_scene={**request,'operation_id':'http-scene','sources':[source],'epoch':guard.current(settings.database)}
            first_http=client.post('/bridge/scene',json=http_scene,headers=headers)
            second_http=client.post('/bridge/scene',json=http_scene,headers=headers)
            assert first_http.status_code==200 and first_http.json()==second_http.json()
            http_id=first_http.json()['id']
            passed.append('authenticated_http_original_to_bound_scene_idempotency')
            switched=event('http-version-switch',mid=7,active=1,text='A different fictional version')
            assert client.post('/bridge/source-events',json=switched,headers=headers).status_code==200
            with Reader(settings.database) as reader:assert not reader.read(http_id)['readable']
            switched_back=event('http-version-return',mid=7,active=0)
            assert client.post('/bridge/source-events',json=switched_back,headers=headers).status_code==200
            with Reader(settings.database) as reader:assert not reader.read(http_id)['readable']
            passed.append('version_return_does_not_resurrect_old_scene')
            withdrawn=event('http-single-delete',mid=7,kind='withdraw')
            assert client.post('/bridge/source-events',json=withdrawn,headers=headers).status_code==200
            with Store(settings.database) as store:
                assert not store.conn.execute("SELECT 1 FROM morrow_source_current WHERE message='7'").fetchone()
                originals=store.conn.execute("SELECT original_json FROM morrow_source_versions WHERE message='7'").fetchall()
                assert len(originals)==3 and all(r[0] for r in originals)
            passed.append('single_delete_preserves_private_original_versions')
        concurrent_event=event('simultaneous-duplicate',mid=8)
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies=list(pool.map(projector.apply,[concurrent_event,concurrent_event]))
        assert replies[0]==replies[1]==protocol.acknowledgement(concurrent_event)
        passed.append('concurrent_duplicate_requests_commit_once')
        replay=root/'synthetic-replay.json';replay.write_text(json.dumps(concurrent_event))
        code='''import sys,json
from pathlib import Path
from serein.config import Settings
from serein_source_projection import Projector
p=Projector(Settings(Path(sys.argv[1]),index=Path(sys.argv[2]),writable=True))
print(json.dumps(p.apply(json.load(open(sys.argv[3])))))
'''
        child=subprocess.run([sys.executable,'-c',code,str(settings.database),str(settings.index),str(replay)],
                             check=True,capture_output=True,text=True,timeout=30)
        assert json.loads(child.stdout)==protocol.acknowledgement(concurrent_event)
        passed.append('actual_new_process_preserves_epoch_and_receipt')
        # Launch the REAL CLI using the installed wheel, not just app factories
        # under a source PYTHONPATH. This catches deployment-entrypoint errors.
        import serein.config as config_module
        audited=Path(config_module.__file__).resolve().parents[2]
        configuration=root/'server.toml'
        configuration.write_text('[storage]\ndatabase='+json.dumps(str(settings.database))+
            '\nindex='+json.dumps(str(settings.index))+'\n[runtime]\nwritable=true\n')
        policy.write_text(json.dumps({'enabled':False,'instance_id':instance,'release':guard.VERSION}))
        secret=root/'synthetic-http-token';secret.write_text('synthetic-entrypoint-only')
        environment=dict(os.environ,PYTHONPATH=str(Path(__file__).resolve().parents[1]),
                         SEREIN_HTTP_TOKEN_FILE=str(secret),PYTHONDONTWRITEBYTECODE='1')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
        command=[sys.executable,str(Path(__file__).resolve().parents[1]/'serein_source_host.py'),
                 '--config',str(configuration),'--policy',str(policy),'--port',str(port),'--upstream-root',str(audited)]
        with (root/'synthetic-entrypoint.log').open('wb') as log:
            process=subprocess.Popen(command,env=environment,stdout=log,stderr=log)
            try:
                for attempt in range(80):
                    if process.poll() is not None:raise AssertionError('Real receiver CLI failed to start')
                    try:
                        with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=1) as response:
                            if response.status==200:break
                    except OSError:pass
                    time.sleep(.25)
                else:raise AssertionError('Real receiver CLI health timed out')
                request=urllib.request.Request(f'http://127.0.0.1:{port}/bridge/capabilities',data=b'{}',
                    headers={'Authorization':'Bearer synthetic-entrypoint-only','Content-Type':'application/json'})
                with urllib.request.urlopen(request,timeout=3) as response:
                    assert json.load(response)['source_enabled'] is False
            finally:
                process.terminate()
                try:process.wait(timeout=20)
                except subprocess.TimeoutExpired:process.kill();process.wait()
        passed.append('real_installed_wheel_cli_startup_and_closed_receiver')
        print(json.dumps({'passed':len(passed),'checks':passed,'paid_model_calls':0,
            'production_source_enabled':False,'automatic_event_acceptance':False}))


if __name__=='__main__':main()

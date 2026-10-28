"""Opt-in actual receiver process; fixed upstream, synthetic data, no models."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import requests
from serein.config import Settings
from serein.bootstrap import initialize
from serein.deployment import save_settings
from serein.core.reader import Reader
from serein.recall.index import build_index,Search
from serein_source_projection import Projector
from serein_source_guard import PINNED
import context_binding as binding
import context_provenance as context
import memory_outbox
import serein_bridge
import source_protocol as protocol
import joint_memory_backup as joint


def main(upstream):
    passed=[]
    with tempfile.TemporaryDirectory(prefix='context-native-synthetic-') as temporary:
        root=Path(temporary);settings=Settings(root/'receiver.db',index=root/'index.db',writable=True)
        initialize(settings);save_settings(settings.database,{'pipeline':{'auto_enabled':False}});Projector(settings)
        host=context.connect(root/'host.db')
        host.executescript('''CREATE TABLE sessions(id INTEGER PRIMARY KEY);INSERT INTO sessions VALUES(1);INSERT INTO sessions VALUES(2);
            CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id INTEGER,role TEXT,content TEXT,
              created_at TEXT DEFAULT '2026-01-01T00:00:00Z',active INTEGER DEFAULT 0,hidden INTEGER DEFAULT 0,
              versions TEXT DEFAULT '[]',attachments TEXT DEFAULT '[]',tool_log TEXT DEFAULT '[]',proactive INTEGER DEFAULT 0);
            CREATE TABLE conversation_summaries(session_id INTEGER PRIMARY KEY,summary TEXT,covered_through_message_id INTEGER DEFAULT 0,raw_overlap_count INTEGER DEFAULT 0);
            CREATE TABLE memory_entries(id INTEGER PRIMARY KEY,content TEXT,kind TEXT DEFAULT 'fixed',tags TEXT DEFAULT '[]',pinned INTEGER DEFAULT 0);
            CREATE TABLE persona(id INTEGER PRIMARY KEY,content TEXT);INSERT INTO persona VALUES(1,'Synthetic core');''')
        memory_outbox.initialize(host);context.initialize(host)
        host.execute('UPDATE memory_bridge_control SET enabled=1');host.execute('UPDATE morrow_context_control SET enabled=1')
        host.execute("INSERT INTO messages(id,session_id,role,content) VALUES(1,1,'user','Fictional silver observatory')");host.commit()
        instance=host.execute('SELECT instance_id FROM memory_bridge_control').fetchone()[0]
        token='synthetic-process-credential-only';assets=root/'identity';assets.mkdir()
        (assets/'token').write_text(token)
        from serein_source_guard import VERSION as guard_version
        (assets/'policy.json').write_text(json.dumps({'enabled':True,'instance_id':instance,'release':guard_version}))
        (assets/'config.toml').write_text('[storage]\ndatabase='+json.dumps(str(settings.database))+'\nindex='+json.dumps(str(settings.index))+'\n[runtime]\nwritable=true\n')
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        url='http://127.0.0.1:'+str(port)
        def post(path,value,credential=token):
            with requests.Session() as session:
                session.trust_env=False
                return session.post(url+'/bridge/'+path,json=value,headers={'Authorization':'Bearer '+credential},timeout=8)
        environment={**os.environ,'SEREIN_HTTP_TOKEN_FILE':str(assets/'token')}
        process=None
        def start():
            with open(root/'synthetic-server-error.txt','a') as log:
                child=subprocess.Popen([sys.executable,str(Path.cwd()/'serein_source_host.py'),
                    '--config',str(assets/'config.toml'),'--policy',str(assets/'policy.json'),
                    '--upstream-root',str(upstream),'--port',str(port)],env=environment,
                    stdout=subprocess.DEVNULL,stderr=log)
            try:
                deadline=time.monotonic()+20
                while time.monotonic()<deadline:
                    if child.poll() is not None:raise AssertionError('Synthetic receiver exited: '+(root/'synthetic-server-error.txt').read_text()[-1800:])
                    try:
                        if post('capabilities',{}).status_code==200:return child
                    except requests.RequestException:pass
                    time.sleep(.1)
                raise AssertionError('Synthetic receiver startup timed out')
            except BaseException:
                child.terminate();child.wait(timeout=10);raise
        def event():
            row=host.execute('SELECT * FROM memory_bridge_outbox ORDER BY sequence DESC LIMIT 1').fetchone()
            head=post('source-status',{'instance_id':instance}).json()
            return protocol.envelope({'instance_id':instance,'event_id':row['event_id'],'kind':row['kind'],
                'message_id':row['message_id'],'session_id':row['session_id'],'message':json.loads(row['payload'])},
                row['sequence'],head['sequence'],head['hash'])
        def request(graph,identifier):
            body={'instance_id':instance,'session_id':graph['session_id'],'operation_id':identifier,'epoch':graph['epoch'],
                  'tool':'write_scene','arguments':{'content':'A subjective fictional observatory recollection','cues':['observatory']},'sources':[]}
            body['context_certificate']=binding.sign(graph,token,identifier,body['tool'],body['arguments'])
            return body
        try:
            process=start()
            assert post('capabilities',{}).json()['certified'] is False
            assert post('capabilities',{},credential='incorrect').status_code==401
            original=event();assert post('source-events',original).json()==protocol.acknowledgement(original)
            assert post('source-events',original).json()==protocol.acknowledgement(original)
            host.execute("UPDATE memory_bridge_outbox SET state='acknowledged'");host.commit()
            passed.append('real_receiver_auth_source_ack_and_duplicate')
            with context.generation(root/'host.db',1) as trace:
                trace.record(host,'message',1);trace.record(host,'persona',1)
                live=memory_outbox.source_context(root/'host.db',1,[{'id':1,'content':'Fictional silver observatory','active':0}],0,trace=trace)
                assert live and live['context_graph']
                with requests.Session() as transport:
                    transport.trust_env=False
                    client=serein_bridge.Bridge({'base_url':url,'token_file':str(assets/'token'),'ledger':str(root/'bridge.db'),
                        'instance_id':'synthetic','tools_enabled':True,'source_gateway_enabled':True},transport)
                    result=client.execute('serein_write_scene',{'content':'Fictional subjective impression','cues':['observatory']},'window','turn',host_context=live)
                    assert result['ok'],result['error']
                    assert client.execute('serein_write_scene',{'content':'Fictional subjective impression','cues':['observatory']},'window','turn',host_context=live)==result
                graph=live['context_graph'];body=request(graph,'direct-proof')
            response=post('scene',body);assert response.status_code==200,response.status_code
            scene=response.json()['id'];assert response.json()['context_verification']['digest']==protocol.fingerprint(body['context_certificate']['payload'])
            assert post('scene',body).json()==response.json()
            passed.append('trace_outbox_bridge_signed_graph_receiver_atomic_receipt')
            with closing(sqlite3.connect(settings.database)) as db:
                assert db.execute('SELECT count(*) FROM morrow_host_context_receipts').fetchone()[0]==2
                assert db.execute('SELECT count(*) FROM morrow_document_dependencies').fetchone()[0]>=2
            passed.append('persisted_context_receipts_and_dependency_edges')
            missing={k:v for k,v in body.items() if k!='context_certificate'}
            assert post('scene',missing).status_code==409
            bad=deepcopy(body);bad['context_certificate']['payload']['objects'][0]['hash']='0'*64
            assert post('scene',bad).status_code==409
            expired=request(graph,'expired');expired['context_certificate']=binding.sign(graph,token,'expired',body['tool'],body['arguments'],now=int(time.time())-60)
            assert post('scene',expired).status_code==409
            passed.append('missing_tampered_and_expired_context_rejected_over_http')
            # Trusted summary dependencies, including a reference from another
            # conversation of the same private household, traverse real leaves.
            with context.generation(root/'host.db',1,'summary') as trace:
                trace.record(host,'message',1);trace.seal()
                host.execute("INSERT INTO conversation_summaries VALUES(1,'Synthetic derived summary',1,0)")
                context.bind(host,'summary',1);host.commit()
            with context.generation(root/'host.db',2) as trace:
                trace.record(host,'summary',1);trace.seal()
                cross=binding.export(root/'host.db',trace,0)
            assert post('scene',request(cross,'cross-private-summary')).status_code==200
            passed.append('proven_summary_cross_private_session_lineage')
            # Old summary/tool/media inputs fail locally, no fake certificate.
            with context.generation(root/'host.db',1) as trace:
                trace.record(host,'message',1);trace.opaque('unknown_tool_result')
                assert binding.export(root/'host.db',trace,0) is None
            passed.append('unknown_indirect_dependency_not_silently_skipped')
            index=root/'stale.db';build_index(settings.database,index)
            host.execute("UPDATE messages SET content='Fictional corrected observatory',active=1 WHERE id=1");host.commit()
            correction=event();competing=request(graph,'inflight-old-epoch')
            with ThreadPoolExecutor(max_workers=2) as executor:
                withdrawal=executor.submit(post,'source-events',correction)
                stale=executor.submit(post,'scene',competing)
                assert withdrawal.result().status_code==200
                stale_result=stale.result();assert stale_result.status_code in (200,409)
            if stale_result.status_code==200:
                with Reader(settings.database) as reader:assert not reader.read(stale_result.json()['id'])['readable']
            assert post('scene',request(graph,'after-withdrawal')).status_code==409
            with Reader(settings.database) as reader:assert not reader.read(scene)['readable']
            with Search(settings.database,index) as search:assert scene not in json.dumps(search.search('observatory'))
            passed.append('concurrent_withdrawal_epoch_barrier_and_stale_index_block')
            process.terminate();process.wait(timeout=10);process=start()
            assert post('source-events',correction).json()==protocol.acknowledgement(correction)
            assert post('source-status',{'instance_id':instance}).json()['sequence']==2
            passed.append('real_service_restart_lost_ack_and_old_certificate_rejection')
            process.terminate();process.wait(timeout=10);process=None
            destination=root/'encrypted';destination.mkdir()
            package,_,state=joint.snapshot({'host':root/'host.db','receiver':settings.database,'index':index,'bridge':root/'bridge.db'},
                {'identity':assets},destination,'synthetic-joint-password',writers_quiesced=True)
            recovered=root/'restored';assert joint.restore(package,recovered,'synthetic-joint-password')==state
            with closing(sqlite3.connect(recovered/'databases'/'receiver.db')) as db:
                assert db.execute('SELECT count(*) FROM morrow_host_context_receipts').fetchone()[0]>=3
            assert state['recall_blocked'] and not state['release_certified']
            passed.append('quiesced_real_process_joint_restore_preserves_graph_receipts_and_block')
        finally:
            if process is not None:process.terminate();process.wait(timeout=10)
            host.close()
    print(json.dumps({'passed':len(passed),'checks':passed,'paid_calls':0},ensure_ascii=False))


if __name__=='__main__':main(Path(sys.argv[1]))

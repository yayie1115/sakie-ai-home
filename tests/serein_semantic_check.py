"""Opt-in budgeted real API check using ONLY synthetic memory data.

Reads provider configuration through a read-only attachment; never copies keys
into fixture databases, arguments, logs or Serein. Creates its own broker and
Serein processes on ephemeral loopback ports, then removes its own fixture.
"""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import requests
from flask import Flask, g
from werkzeug.serving import make_server
import memory_models


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--serein-python',required=True)
    parser.add_argument('--provider-database',required=True,type=Path)
    parser.add_argument('--embedding-provider',required=True,type=int)
    parser.add_argument('--embedding-model',required=True)
    parser.add_argument('--reranker-provider',required=True,type=int)
    parser.add_argument('--reranker-model',required=True)
    args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='serein-real-model-synthetic-') as work:
        root=Path(work);os.chmod(root,0o700);token=secrets.token_urlsafe(32)
        state_path=root/'broker.db'
        def connect():
            db=sqlite3.connect(state_path,uri=True);db.row_factory=sqlite3.Row
            db.execute('ATTACH DATABASE ? AS provider_source',(args.provider_database.resolve().as_uri()+'?mode=ro',))
            db.execute('CREATE TEMP VIEW providers AS SELECT * FROM provider_source.providers')
            return db
        with closing(connect()) as db:
            db.execute('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)');db.commit()
            state={'revision':1,'embedding':{'provider_id':args.embedding_provider,'model_id':args.embedding_model},
                'reranker':{'provider_id':args.reranker_provider,'model_id':args.reranker_model},'validation':{}}
            memory_models.store(db,state);db.commit()
            for role in memory_models.ROLES:
                selection=state[role];signature=memory_models.resolve(db,selection)[2]
                payload={'model':selection['model_id']}
                payload.update({'input':['合成测试：蓝色纸船。']} if role=='embedding' else
                               {'query':'蓝色纸船','documents':['蓝色纸船。','红色山峰。']})
                result=memory_models.provider_request(db,role,payload)
                state['validation'][role]={'status':'verified','signature':signature,
                    'dimension':len(result['data'][0]['embedding']) if role=='embedding' else None}
            memory_models.store(db,state);db.commit()
        web=Flask('synthetic_broker')
        def get_db():
            if 'db' not in g:g.db=connect()
            return g.db
        @web.teardown_appcontext
        def close(error):
            if 'db' in g:g.db.close()
        def no_browser_access(fn):
            from functools import wraps
            @wraps(fn)
            def denied(*a,**k):return {'error':'synthetic-only'},403
            return denied
        memory_models.register(web,get_db,no_browser_access,broker_secret=token)
        server=make_server('127.0.0.1',0,web,threaded=True)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        origin='http://127.0.0.1:'+str(server.server_port)
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        secret=root/'token';secret.write_text(token);os.chmod(secret,0o600)
        config=root/'config.toml';config.write_text(f'[storage]\ndatabase="{root}/serein.db"\nindex="{root}/index.sqlite"\n[runtime]\nwritable=true\n')
        report=root/'setup.json'
        # Public modules only; provider secrets never enter this subprocess.
        setup='''
import sys,json,re
from pathlib import Path
from serein.config import load_settings
from serein.bootstrap import initialize
from serein.application import Application
from serein.api.authored_tools import tools_for
from serein.deployment import save_settings
from serein_model_sync import synchronize
s=load_settings(sys.argv[1]);initialize(s)
save_settings(s.database,{'pipeline':{'auto_enabled':False}})
t=tools_for(Application(s).services,s)
t['write_scene'](content='我们把蓝色纸船放进玻璃花房东侧抽屉，约好周日一起取。',cues=['蓝色纸船','玻璃花房'],title='蓝色纸船的位置',date='2026-01-01')
t['write_scene'](content='我们曾在山顶看红色风筝，后来把它留在观景台。',cues=['红色风筝','观景台'],title='山顶风筝',date='2026-01-02')
r=synchronize(s,sys.argv[2],Path(sys.argv[3]).read_text(),prepare=True)
assert r['memory']['ready'],r
Path(sys.argv[4]).write_text(json.dumps(r))
'''
        env={**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]),'PYTHONDONTWRITEBYTECODE':'1'}
        child=None
        log=open(root/'synthetic.log','w')
        try:
            subprocess.run([args.serein_python,'-c',setup,str(config),origin,str(secret),str(report)],
                           env=env,stdout=log,stderr=log,check=True,timeout=300)
            env['SEREIN_HTTP_TOKEN_FILE']=str(secret)
            child=subprocess.Popen([args.serein_python,'-m','serein.launch','--config',str(config),'http','--live','--host','127.0.0.1','--port',str(port)],env=env,stdout=log,stderr=log)
            address=f'http://127.0.0.1:{port}'
            for _ in range(120):
                if child.poll() is not None:raise RuntimeError('Synthetic Serein startup failed')
                try:
                    if requests.get(address+'/health',timeout=.3).status_code==200:break
                except requests.RequestException:pass
                time.sleep(.1)
            import serein_bridge
            client=serein_bridge.Bridge({'base_url':address,'token_file':str(secret),
                'ledger':str(root/'deliveries.db'),'hook_enabled':True,'hook_ready':True,'recall_timeout':4})
            started=time.monotonic();turn=client.prepare('synthetic-window','synthetic-receipt','你还记得我们把蓝色纸船放在哪里了吗？')
            duration=time.monotonic()-started
            assert turn['state']=='prepared' and turn['ids'] and '东侧抽屉' in turn['context'],'Real model Hook did not recall expected synthetic memory'
            assert client.ledger.recent('synthetic-window')==[]
            client.acknowledge(turn)
            repeated=client.prepare('synthetic-window','synthetic-next','你还记得我们把蓝色纸船放在哪里了吗？')
            assert not repeated['ids'],'Delivered memory was repeated inside cooldown'
            with closing(connect()) as db:
                budget=[json.loads(r[0]) for r in db.execute("select value from settings where key like 'memory_model_budget_%'")]
            result={'embedding_and_reranker_interfaces':True,'serein_index_and_routes':True,
                'real_model_hook_recalled_synthetic_memory':True,'cooldown_and_ack':True,
                'first_hook_seconds':round(duration,3),'budget':budget,'chat_model_calls':0,
                'private_chat_reads':0,'production_data_writes':0}
            print(json.dumps(result))
        except Exception:
            # Do not dump provider logs or credentials. Retain only generic failure.
            print(json.dumps({'success':False,'error':'synthetic_semantic_check_failed','chat_model_calls':0}))
            raise
        finally:
            if child and child.poll() is None:child.terminate();child.wait(timeout=20)
            server.shutdown();thread.join(timeout=5);log.close()


if __name__=='__main__':main()

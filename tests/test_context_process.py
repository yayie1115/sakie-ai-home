"""Real isolated HTTP process with synthetic authentication and storage only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

import requests


class ContextProcessTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        root=Path(cls.temp.name);cls.root=root
        environment={**os.environ,'AUTH_PASSWORD':'synthetic-http-password','SECRET_KEY':'synthetic-http-secret',
            'FLASK_DEBUG':'0','DB_PATH':str(root/'host.db'),'MORROW_SEREIN_CONFIG':str(root/'not-configured.json'),
            'LLM_API_KEY':''}
        code='''import sys
sys.path.insert(0,sys.argv[1])
import dotenv
dotenv.load_dotenv=lambda *a,**k:False
import app,context_provenance as c
from pathlib import Path
from werkzeug.serving import make_server
app.init_db()
with c.connect(app.DB_PATH) as db:
 c.initialize(db)
 db.execute('UPDATE morrow_context_control SET enabled=1')
server=make_server('127.0.0.1',0,app.app)
Path(sys.argv[2]).write_text(str(server.server_port))
server.serve_forever()
'''
        cls.process=subprocess.Popen([sys.executable,'-c',code,str(Path.cwd()),str(root/'ready')],
            cwd=root,env=environment,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        deadline=time.monotonic()+20
        while not (root/'ready').exists() and cls.process.poll() is None and time.monotonic()<deadline:
            time.sleep(.05)
        if not (root/'ready').exists():
            cls.process.terminate();cls.process.wait(timeout=5);cls.temp.cleanup()
            raise AssertionError('Synthetic HTTP process failed to start')
        cls.url='http://127.0.0.1:'+(root/'ready').read_text()
        cls.session=requests.Session();cls.session.trust_env=False

    @classmethod
    def tearDownClass(cls):
        cls.session.close();cls.process.terminate();cls.process.wait(timeout=5);cls.temp.cleanup()

    def test_unauthorized_http_cannot_grant_owner_scope(self):
        response=self.session.post(self.url+'/api/memory/entries',json={'content':'Untrusted fictional entry'},timeout=5)
        self.assertEqual(response.status_code,401)

    def test_authenticated_owner_crud_persists_with_guards_enabled(self):
        headers={'X-Auth-Password':'synthetic-http-password'}
        response=self.session.post(self.url+'/api/memory/entries',headers=headers,
            json={'content':'Independent synthetic owner memory'},timeout=5)
        self.assertEqual(response.status_code,201)
        identifier=response.json()['id']
        response=self.session.put(self.url+'/api/memory/entries/'+str(identifier),headers=headers,
            json={'content':'Corrected synthetic owner memory'},timeout=5)
        self.assertEqual(response.status_code,200)
        records=self.session.get(self.url+'/api/memory/entries',headers=headers,timeout=5).json()
        self.assertTrue(any(row['id']==identifier and row['content']=='Corrected synthetic owner memory' for row in records))
        self.assertEqual(self.session.delete(self.url+'/api/memory/entries/'+str(identifier),headers=headers,timeout=5).status_code,200)


if __name__=='__main__':unittest.main()

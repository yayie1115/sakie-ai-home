"""Pinned upstream + joint backup: synthetic sources, no embedding/model calls."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from serein.config import Settings
from serein.bootstrap import initialize
from serein.deployment import save_settings
from serein.core.reader import Reader
from serein.recall.index import build_index, Search
from serein_source_projection import Projector
from serein_source_receiver import author_scene
import serein_source_guard as guard
import joint_memory_backup as joint
import memory_outbox
import source_protocol as protocol


def main():
    with tempfile.TemporaryDirectory(prefix='joint-native-synthetic-') as temporary:
        root=Path(temporary)
        settings=Settings(root/'receiver.db',index=root/'index.db',writable=True)
        initialize(settings);save_settings(settings.database,{'pipeline':{'auto_enabled':False}})
        projector=Projector(settings)
        host=sqlite3.connect(root/'host.db');host.row_factory=sqlite3.Row
        try:
            host.executescript('''CREATE TABLE sessions(id INTEGER PRIMARY KEY);INSERT INTO sessions VALUES(1);
                CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id INTEGER,role TEXT,content TEXT,
                  created_at TEXT DEFAULT '2026-01-01T00:00:00Z',active INTEGER DEFAULT 0,hidden INTEGER DEFAULT 0,
                  versions TEXT DEFAULT '[]',attachments TEXT DEFAULT '[]');''')
            memory_outbox.initialize(host)
            host.execute('UPDATE memory_bridge_control SET enabled=1,recall_blocked=1')
            host.execute("INSERT INTO messages(id,session_id,role,content) VALUES(1,1,'user','Fictional violet telescope')")
            host.commit()
            instance=host.execute('SELECT instance_id FROM memory_bridge_control').fetchone()[0]
            def pending(db,remote):
                row=db.execute('SELECT * FROM memory_bridge_outbox ORDER BY sequence DESC LIMIT 1').fetchone()
                head=remote.head(instance)
                return protocol.envelope({'instance_id':instance,'event_id':row['event_id'],'kind':row['kind'],
                    'message_id':row['message_id'],'session_id':row['session_id'],'message':json.loads(row['payload'])},
                    row['sequence'],head['sequence'],head['hash'])
            first=pending(host,projector);projector.apply(first)
            source={'message_id':1,'event_id':first['event_id'],'version':0,
                    'content_hash':hashlib.sha256(first['message']['text'].encode()).hexdigest()}
            scene=author_scene(settings,{'instance_id':instance,'session_id':1,'operation_id':'synthetic-native-scene',
                'tool':'write_scene','arguments':{'content':'Fictional violet telescope recollection','cues':['violet telescope']},
                'sources':[source],'epoch':guard.current(settings.database)})
            built_index=root/'snapshot-index.db'
            build_index(settings.database,built_index)
            assets=root/'identity';assets.mkdir();(assets/'identity.txt').write_text('synthetic fixture identity')
            destination=root/'encrypted';destination.mkdir()
            package,_,state=joint.snapshot({'host':root/'host.db','receiver':settings.database,'index':built_index},
                {'identity':assets},destination,'synthetic-native-password',writers_quiesced=True)
            target=root/'recovered'
            assert joint.restore(package,target,'synthetic-native-password')==state
            recovered=Settings(target/'databases'/'receiver.db',index=target/'databases'/'index.db',writable=True)
            with Reader(recovered.database) as reader:assert reader.read(scene['id'])['readable']
            print('PASS native_schema_encrypted_snapshot_and_restore')
            remote=Projector(recovered)
            assert remote.apply(first)==protocol.acknowledgement(first)
            assert remote.head(instance)['sequence']==1
            print('PASS native_lost_ack_replay_without_duplicate')
            with closing(sqlite3.connect(target/'databases'/'host.db')) as resumed:
                resumed.row_factory=sqlite3.Row
                resumed.execute("UPDATE messages SET content='Fictional corrected telescope',active=1 WHERE id=1")
                resumed.commit()
                correction=pending(resumed,remote);remote.apply(correction)
                with Reader(recovered.database) as reader:assert not reader.read(scene['id'])['readable']
                with Search(recovered.database,recovered.index) as search:
                    assert scene['id'] not in json.dumps(search.search('violet telescope'))
                assert guard.current(recovered.database)>state['receiver']['sequence']-1
                assert resumed.execute('SELECT recall_blocked FROM memory_bridge_control').fetchone()[0]==1
            print('PASS restored_native_withdrawal_and_stale_index_block')
        finally:host.close()


if __name__=='__main__':main()

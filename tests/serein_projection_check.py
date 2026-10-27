"""Offline pinned-Serein source withdrawal candidate checks, new synthetic DB only."""
from pathlib import Path
import sys
import tempfile

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from serein.config import Settings
from serein.bootstrap import initialize
from serein.deployment import save_settings
from serein.core.store import Store,encode
from serein.core.reader import Reader
from serein_source_projection import Projector,SourceConflict
import source_protocol
import serein_source_guard as guard


def main():
    passed=[]
    with tempfile.TemporaryDirectory(prefix='serein-source-projection-') as work:
        settings=Settings(Path(work)/'synthetic.db',index=Path(work)/'index.db',writable=True)
        initialize(settings);save_settings(settings.database,{'pipeline':{'auto_enabled':False}})
        projector=Projector(settings)
        envelopes={}
        def event(key,kind='upsert',message_id=1,session_id=1,text='fictional original'):
            if key not in envelopes:
                head=projector.head('synthetic')
                envelopes[key]=source_protocol.envelope(
                    {'event_id':key,'kind':kind,'instance_id':'synthetic',
                     'message_id':None if kind=='withdraw_session' else message_id,'session_id':session_id,
                     'message':{'role':'user','text':text,'created_at':'2026-01-01T00:00:00Z','hidden':0,'partial':0}},
                    head['sequence']+1,head['sequence'],head['hash'])
            return envelopes[key]
        first=event('first');projector.apply(first);projector.apply(first)
        with guard.scope(settings.database,authoring=True), Store(settings.database) as store:
            assert store.conn.execute('select count(*) from raw_events').fetchone()[0]==1
            raw=store.conn.execute('select * from raw_events').fetchone()
            source=store.add_source(encode([raw['source'],raw['session_id'],raw['source_event_id']]),raw['text'])
            for kind in ['scene','event']:
                store.create('synthetic-'+kind,kind,'Synthetic source memory','fictional original')
                store.bind('synthetic-'+kind,source)
        passed.append('idempotent_original_archive')
        try:projector.apply({**first,'message':{**first['message'],'text':'conflict'}});raise AssertionError()
        except SourceConflict:passed.append('same_id_content_conflict')
        projector.apply(event('edit',text='fictional correction'))
        with Reader(settings.database) as reader:
            for kind in ['scene','event']:
                assert not reader.read('synthetic-'+kind)['readable']
                assert not reader.read('synthetic-'+kind,revision=1)['readable']
        with Store(settings.database) as store:
            assert store.conn.execute('select count(*) from evidence_bindings where active=1').fetchone()[0]==0
            assert store.conn.execute('select text from raw_events').fetchone()[0]=='fictional correction'
            assert 'fictional original' in store.conn.execute('select original_json from morrow_source_vault').fetchone()[0]
        passed.extend(['source_edit_hides_bound_scene_and_event','historical_revision_cannot_bypass','original_retained_in_private_vault'])
        Projector(settings).apply(event('edit',text='fictional correction'))
        passed.append('restart_and_lost_ack_replay')
        projector.apply(event('withdraw',kind='withdraw'))
        with Store(settings.database) as store:assert store.conn.execute('select count(*) from raw_events').fetchone()[0]==0
        passed.append('single_message_withdrawal')
        projector.apply(event('new-2',message_id=2));projector.apply(event('new-3',message_id=3))
        projector.apply(event('delete-session',kind='withdraw_session'))
        with Store(settings.database) as store:assert store.conn.execute('select count(*) from raw_events').fetchone()[0]==0
        passed.append('session_withdrawal')
        partial=event('partial',message_id=4);partial['message']['partial']=1;projector.apply(partial)
        with Store(settings.database) as store:assert store.conn.execute('select count(*) from raw_events').fetchone()[0]==0
        passed.append('partial_reply_not_archived_as_complete')
        save_settings(settings.database,{'pipeline':{'auto_enabled':True}})
        try:projector.apply(event('unsafe'));raise AssertionError()
        except SourceConflict:passed.append('active_pipeline_blocks_candidate_projection')
        save_settings(settings.database,{'pipeline':{'auto_enabled':False}})
        before=projector.head('synthetic')
        malformed=event('bad-original');malformed['message']['created_at']='not-a-date'
        try:projector.apply(malformed);raise AssertionError('invalid original accepted')
        except (SourceConflict,ValueError):pass
        assert projector.head('synthetic')==before
        with Store(settings.database) as store:
            assert not store.conn.execute("select 1 from morrow_source_stream_receipts where event_id='bad-original'").fetchone()
        passed.append('failed_original_cannot_advance_cursor')
        corrupt=event('bad-order');corrupt['previous_hash']='a'*64
        try:projector.apply(corrupt);raise AssertionError('bad chain accepted')
        except SourceConflict:pass
        assert projector.head('synthetic')==before
        passed.append('out_of_order_projection_zero_writes')
        local_time=event('local-time',message_id=5)
        local_time['message']['created_at']='2026-01-01 08:30:00'
        projector.apply(local_time)
        with Store(settings.database) as store:
            row=store.conn.execute('SELECT created_at,metadata_json FROM raw_events').fetchone()
            from datetime import datetime,timezone
            assert datetime.fromisoformat(row['created_at']).astimezone(timezone.utc).hour==0
            assert '2026-01-01 08:30:00' in row['metadata_json']
        passed.append('morrow_wall_clock_explicit_utc8_original_retained')
    import json
    print(json.dumps({'passed':len(passed),'checks':passed,
        'separate_acceptance_required':['full_host_context_dependencies','independent_memory_writers','automatic_event_pipeline'],
        'registers_production_routes':False}))


if __name__=='__main__':main()

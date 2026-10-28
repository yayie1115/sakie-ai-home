"""Host-signed context graphs; the receiver independently resolves raw evidence.

The existing private bridge credential authenticates the host, NOT the model.
No model argument supplies a graph, signature, source quote, or authority flag.
Local completeness is necessary, never a receiver certification by itself.
"""
from contextlib import closing
import hashlib
import hmac
import json
import time
from pathlib import Path
from datetime import datetime,timedelta,timezone

import context_provenance as provenance
from source_protocol import SourceConflict, canonical, fingerprint

VERSION='morrow-context-binding-v1'
LIMIT=256


def operation(identifier,tool,arguments):
    return fingerprint([identifier,tool,arguments])


def sign(context,key,identifier,tool,arguments,*,now=None):
    """Only the Bridge calls this with a host-built, current graph."""
    if not isinstance(key,str) or not key:raise SourceConflict('Host signing credential unavailable')
    now=int(time.time()) if now is None else now
    value={**context,'operation':operation(identifier,tool,arguments),'issued_at':now,'expires_at':now+30}
    tag=hmac.new(key.encode(),(VERSION+'\n'+canonical(value)).encode(),hashlib.sha256).hexdigest()
    return {'payload':value,'signature':tag}


def export(db_path,trace,epoch):
    """Read one host snapshot; every referenced source must be archived/ACKed."""
    import memory_outbox
    if trace is None or type(epoch) is not int or epoch<0:return None
    if trace.path!=str(Path(db_path).resolve()):return None
    trace.seal()
    with closing(provenance.connect(db_path)) as db:
        db.execute('BEGIN')
        if not provenance.configured(db) or not provenance.valid_manifest(db,trace.identifier):return None
        control=db.execute('SELECT * FROM memory_bridge_control WHERE id=1').fetchone()
        if not control or not control['enabled'] or control['recall_blocked']:return None
        nodes={};objects={}
        def visit(identifier,stack=()):
            if identifier in stack:raise SourceConflict('Context cycle')
            if identifier in nodes:return
            if len(nodes)>=LIMIT or not provenance.valid_manifest(db,identifier):raise SourceConflict('Context dependency unverified')
            row=db.execute('SELECT * FROM morrow_context_manifests WHERE id=?',(identifier,)).fetchone()
            value=json.loads(row['payload'])
            nodes[identifier]={'id':identifier,'digest':row['digest'],'payload':value}
            for prior in value.get('inputs',[]):
                if not prior.get('manifest'):raise SourceConflict('Prior summary dependency unknown')
                visit(prior['manifest'],(*stack,identifier))
            for dep in value['dependencies']:
                key=(dep['kind'],dep['key'])
                actual=provenance.snapshot(db,*key)
                if actual is None or provenance.digest(actual)!=dep['hash']:raise SourceConflict('Host object changed')
                if key in objects and objects[key]['hash']!=dep['hash']:raise SourceConflict('Conflicting host object versions')
                item={'kind':key[0],'key':key[1],'hash':dep['hash'],'snapshot':actual,'manifest':dep.get('manifest')}
                if key[0]=='message':
                    if actual['attachments'] or actual['tool_log']:raise SourceConflict('Unverified media/tool dependency')
                    # Use this SAME SQLite read transaction, not a second read
                    # whose state could cross a concurrent host edit.
                    item['source']=memory_outbox.resolve_source(db,actual['session_id'],{
                        'id':actual['id'],'content':actual['content'],'active':actual['active']})
                elif key[0] not in ('persona','summary','memory'):raise SourceConflict('Unsupported dependency')
                if key[0] in ('summary','memory') and not item['manifest']:
                    owner=db.execute("SELECT 1 FROM morrow_context_derivations WHERE kind=? AND object_key=? AND hash=? AND origin='owner'",(*key,dep['hash'])).fetchone()
                    if not owner:raise SourceConflict('Independent owner assertion not verified')
                    item['origin']='owner_assertion_not_message_quote'
                if key in objects and objects[key]!=item:raise SourceConflict('Conflicting object lineage')
                objects[key]=item
                if dep.get('manifest'):visit(dep['manifest'],(*stack,identifier))
        visit(trace.identifier)
        if len(objects)>LIMIT:raise SourceConflict('Context graph too large')
        return {'version':VERSION,'instance_id':control['instance_id'],'session_id':trace.session_id,
                'epoch':epoch,'root':trace.identifier,'nodes':list(nodes.values()),'objects':list(objects.values())}


def verify(db,certificate,key,body,resolve,*,now=None):
    """Called inside the receiver's write/epoch transaction; no trusted flags."""
    try:
        if not isinstance(certificate,dict) or set(certificate)!={'payload','signature'}:raise ValueError()
        value=certificate['payload']
        if set(value)!={'version','instance_id','session_id','epoch','root','nodes','objects','operation','issued_at','expires_at'}:raise ValueError()
        expected=hmac.new(key.encode(),(VERSION+'\n'+canonical(value)).encode(),hashlib.sha256).hexdigest()
        if not isinstance(certificate['signature'],str) or not hmac.compare_digest(expected,certificate['signature']):raise ValueError()
        now=int(time.time()) if now is None else now
        if (type(value['issued_at']) is not int or type(value['expires_at']) is not int
                or not value['issued_at']-2<=now<=value['expires_at'] or value['expires_at']-value['issued_at']!=30):raise ValueError()
        if (value['version']!=VERSION or value['instance_id']!=body['instance_id']
                or value['session_id']!=body['session_id'] or value['epoch']!=body['epoch']
                or value['operation']!=operation(body['operation_id'],body['tool'],body['arguments'])):raise ValueError()
        if not isinstance(value['nodes'],list) or not 1<=len(value['nodes'])<=LIMIT:raise ValueError()
        if not isinstance(value['objects'],list) or len(value['objects'])>LIMIT:raise ValueError()
        nodes={node['id']:node for node in value['nodes']}
        objects={(obj['kind'],obj['key']):obj for obj in value['objects']}
        if len(nodes)!=len(value['nodes']) or len(objects)!=len(value['objects']):raise ValueError()
        if nodes[value['root']]['payload']['session_id']!=body['session_id']:raise ValueError()
        visited=set();used=set();resolved={}
        def walk(identifier,stack=()):
            if identifier in stack:raise ValueError()
            if identifier in visited:return
            node=nodes[identifier];payload=node['payload']
            if (set(node)!={'id','digest','payload'} or provenance.digest(payload)!=node['digest']
                    or payload.get('version')!=provenance.VERSION or payload.get('unknown')!=[]):raise ValueError()
            for prior in payload.get('inputs',[]):
                if (set(prior)!={'kind','key','hash','manifest'} or prior['kind']!='previous_summary'
                        or not isinstance(prior['hash'],str) or len(prior['hash'])!=64):raise ValueError()
                walk(prior['manifest'],(*stack,identifier))
            for dep in payload['dependencies']:
                pair=(dep['kind'],dep['key']);obj=objects[pair];actual=obj['snapshot']
                if dep.get('status') not in ('primary','valid','independent'):raise ValueError()
                if provenance.digest(actual)!=dep['hash'] or obj['hash']!=dep['hash'] or obj.get('manifest')!=dep.get('manifest'):raise ValueError()
                used.add(pair)
                if pair[0]=='message':
                    if dep['status']!=('primary' if actual['role']=='user' else 'valid'):raise ValueError()
                    if (actual['attachments'] or actual['tool_log'] or str(actual['id'])!=pair[1]
                            or actual['hidden'] or dep['session_id']!=actual['session_id'] or dep['version']!=actual['active']):raise ValueError()
                    ref=obj['source']
                    if (ref['message_id']!=actual['id'] or ref['version']!=actual['active']
                            or ref['content_hash']!=hashlib.sha256(actual['content'].encode()).hexdigest()
                            or dep.get('source_event_id')!=ref['event_id']):raise ValueError()
                    # Receiver resolves archive + receipt + current version and
                    # compares exact content; the model never supplies quotes.
                    evidence=resolve(db,body['instance_id'],actual['session_id'],[ref])[0]
                    timestamp=datetime.fromisoformat(actual['created_at'].replace('Z','+00:00'))
                    if timestamp.tzinfo is None:timestamp=timestamp.replace(tzinfo=timezone(timedelta(hours=8)))
                    if (evidence['metadata']['role']!=actual['role'] or evidence['content']!=actual['content']
                            or evidence['metadata']['created_at']!=timestamp.isoformat()):raise ValueError()
                    resolved[evidence['source_key']]=evidence
                    if actual['role']=='assistant' and not dep.get('manifest'):raise ValueError()
                elif pair[0]=='persona':
                    if dep['status']!='independent':raise ValueError()
                elif pair[0] in ('memory','summary'):
                    if dep['status']!=('valid' if dep.get('manifest') else 'independent'):raise ValueError()
                    if not dep.get('manifest') and obj.get('origin')!='owner_assertion_not_message_quote':raise ValueError()
                else:raise ValueError()
                if dep.get('manifest'):walk(dep['manifest'],(*stack,identifier))
            visited.add(identifier)
        walk(value['root'])
        if visited!=set(nodes) or used!=set(objects) or not resolved:raise ValueError()
        return list(resolved.values()),fingerprint(value)
    except (ValueError,KeyError,TypeError,AttributeError,IndexError,RecursionError):
        raise SourceConflict('Host context certificate rejected') from None

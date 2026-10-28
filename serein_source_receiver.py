"""Authenticated loopback receiver over the existing ordered source protocol.

Policy is a private file, closed by default. Merely installing routes cannot
enable exports or automatic Event processing. Host source refs are dependencies
of an authored Scene, never proof that its subjective prose is factual.
"""
import hashlib
import hmac
import json
from datetime import date
from pathlib import Path

from source_protocol import SourceConflict, fingerprint, PROTOCOL
import serein_source_guard as guard


def policy(path):
    try:
        value=json.loads(Path(path).read_text(encoding='utf-8'))
        if set(value) != {'enabled','instance_id','release'} or type(value['enabled']) is not bool:
            raise ValueError()
        if not isinstance(value['instance_id'],str) or not value['instance_id'] or value['release'] != guard.VERSION:
            raise ValueError()
        return value
    except (OSError,ValueError,TypeError):
        return {'enabled':False,'instance_id':'','release':guard.VERSION}


def trusted_sources(db, instance, session, refs):
    """Resolve exact host references; never accept caller-supplied quotes."""
    from serein.core.store import encode
    if not isinstance(refs,list) or not 1<=len(refs)<=200:
        raise SourceConflict('Verified host context is required')
    result=[]; seen=set()
    for ref in refs:
        if (not isinstance(ref,dict) or set(ref) != {'message_id','event_id','version','content_hash'}
                or type(ref['message_id']) is not int or type(ref['version']) is not int):
            raise SourceConflict('Invalid host source reference')
        row=db.execute('''SELECT v.*,r.source,r.source_event_id,r.text,r.created_at,r.role
            FROM morrow_source_versions v JOIN morrow_source_current c
              ON c.instance=v.instance AND c.message=v.message AND c.raw_id=v.raw_id
            JOIN raw_events r ON r.id=v.raw_id
            WHERE v.instance=? AND v.session=? AND v.message=? AND v.event_id=? AND v.state='current' ''',
            (instance,str(session),str(ref['message_id']),ref['event_id'])).fetchone()
        if (row is None or row['version']!=ref['version'] or row['content_hash']!=ref['content_hash']
                or hashlib.sha256(row['text'].encode()).hexdigest()!=ref['content_hash']):
            raise SourceConflict('Host source was revised, withdrawn, or not archived')
        try:
            original=json.loads(row['original_json'])
            receipt=db.execute('SELECT hash FROM morrow_source_stream_receipts WHERE instance=? AND event_id=?',
                               (instance,ref['event_id'])).fetchone()
            if (not receipt or fingerprint(original)!=receipt[0] or original['event_id']!=ref['event_id']
                    or original['message']['active']!=ref['version']):
                raise ValueError()
        except (ValueError,KeyError,TypeError):
            raise SourceConflict('Source archive and durable receipt disagree') from None
        if row['event_id'] in seen:
            raise SourceConflict('Repeated host source reference')
        seen.add(row['event_id'])
        result.append({'source_key':encode([row['source'],str(session),row['event_id']]),'content':row['text'],
                       'metadata':{'binding_method':'morrow_host_context','evidence_kind':'adjacent_context',
                                   'source_system':row['source'],'session_id':str(session),'message_id':row['event_id'],
                                   'host_message_id':ref['message_id'],'host_version':ref['version'],
                                   'content_sha256':ref['content_hash'],'role':row['role'],'created_at':row['created_at'],
                                   'scope':'context_dependency_not_factual_support'}})
    return result


def author_scene(settings, body, *, host_key=None, require_context=False):
    from serein.core.writer import Writer
    from serein.core.store import now, encode
    from serein.compat.scenes import Scenes, map_evidence_ids
    from serein.deployment import read_from_store
    base={'instance_id','session_id','operation_id','tool','arguments','sources','epoch'}
    if (not isinstance(body,dict) or set(body) not in (base,base|{'context_certificate'})
            or type(body['session_id']) is not int or type(body['epoch']) is not int
            or not isinstance(body['operation_id'],str) or not 1<=len(body['operation_id'])<=128):
        raise SourceConflict('Invalid host authoring request')
    tool,args=body['tool'],body['arguments']
    allowed={'write_scene':{'content','cues','title','date','domain','favorite'},
             'edit_scene':{'scene_id','expected_updated_at','title','content','cues'},
             'set_scene_status':{'scene_id','expected_updated_at','status','restore_surface'}}
    if tool not in allowed or not isinstance(args,dict) or not set(args)<=allowed[tool]:
        raise SourceConflict('Unsupported authoring fields; model evidence is not accepted')
    with guard.scope(settings.database,body['epoch'],authoring=True), Writer(settings.database,
            favorite_policy=lambda store:read_from_store(store)['features']['favorites']) as writer, writer.store.transaction(immediate=True):
        db=writer.store.conn
        if guard.epoch(db)!=body['epoch']:
            raise SourceConflict('Host authoring context epoch has expired')
        certificate=body.get('context_certificate')
        context_hash=None
        if certificate is not None:
            if not host_key or body['sources']!=[]:raise SourceConflict('Authenticated complete context required')
            import context_binding
            resolved,context_hash=context_binding.verify(db,certificate,host_key,body,trusted_sources)
        else:
            if require_context:raise SourceConflict('Complete context certificate required')
            resolved=trusted_sources(db,body['instance_id'],body['session_id'],body['sources'])
        def prepare(_):
            if tool=='write_scene':
                content=args.get('content','')
                if not isinstance(content,str) or not content.strip(): raise ValueError('Scene content required')
                cues=Scenes._cues(args.get('cues'))
                if args.get('date'):date.fromisoformat(args['date'])
                request={'kind':'scene','title':args.get('title') or content[:40],'body_md':content,
                         'sources':resolved,'actor':'morrow_host_context',
                         'metadata':{'object_kind':'scene','memory_value_source':'authored_scene',
                             'write_contract':'write-scene-v1','scene_cues':cues,'date':args.get('date',''),
                             'canonical_domain':args.get('domain') or 'general','domain':[args.get('domain') or 'general'],
                             'scene_status':'active','active':True,'created':now(),
                             'source_origin':'morrow_host_context','evidence_scope':'context_dependency_not_factual_support'}}
                if 'favorite' in args:request['favorite']=args['favorite']
                return request
            doc=writer.store.read(args.get('scene_id',''))
            if (not doc or doc['kind']!='scene' or doc['lifecycle']=='deleted'
                    or doc['metadata'].get('source_origin')!='morrow_host_context'):
                raise SourceConflict('Only active host-bound Scenes can be revised through this endpoint')
            if doc['updated_at']!=args.get('expected_updated_at'):
                raise SourceConflict('Scene revision changed')
            request={'document_id':doc['id'],'expected_revision':doc['revision']}
            if tool=='set_scene_status':
                status=args.get('status')
                if status not in ('active','archived','deleted'):raise ValueError('Invalid Scene status')
                if type(args.get('restore_surface',False)) is not bool:raise ValueError('Invalid restore flag')
                request['lifecycle']=status
                if args.get('restore_surface'):
                    if status!='active':raise ValueError('Restore surface requires active status')
                    request['can_surface']=True
                return request
            meta=dict(doc['metadata'])
            if 'cues' in args:meta['scene_cues']=Scenes._cues(args['cues'])
            return {**request,'kind':'scene','title':args.get('title',doc['title']),
                    'body_md':args.get('content',doc['body_md']),'metadata':meta,'sources':resolved,'actor':'morrow_host_context'}
        # Stable request fingerprint uses only the original host arguments/refs;
        # generated timestamps live in prepare AFTER retry-receipt verification.
        action='state' if tool=='set_scene_status' else 'save'
        result=writer.execute('morrow-host:'+body['operation_id'],action,body,prepare=prepare)
        key=result['id']
        if context_hash:
            value=certificate['payload']
            nodes={node['id']:node for node in value['nodes']}
            def context_id(identifier):
                return 'morrow-context:'+body['instance_id']+':'+nodes[identifier]['digest']
            root_node=context_id(value['root'])
            db.execute('INSERT OR IGNORE INTO morrow_host_context_receipts VALUES (?,?,?,?)',
                       (body['operation_id'],context_hash,root_node,body['epoch']))
            db.execute('INSERT OR IGNORE INTO morrow_document_dependencies VALUES (?,?)',(key,root_node))
            for node in value['nodes']:
                current=context_id(node['id'])
                for dep in node['payload']['dependencies']:
                    if dep.get('manifest'):
                        db.execute('INSERT OR IGNORE INTO morrow_document_dependencies VALUES (?,?)',(current,context_id(dep['manifest'])))
                for prior in node['payload'].get('inputs',[]):
                    db.execute('INSERT OR IGNORE INTO morrow_document_dependencies VALUES (?,?)',(current,context_id(prior['manifest'])))
                # All resolved leaves are conservative dependencies. This is
                # lineage, not a claim that a subjective Scene quotes a fact.
                for ref in resolved:
                    db.execute('INSERT OR IGNORE INTO morrow_context_source_dependencies VALUES (?,?)',(current,ref['source_key']))
        if not (tool=='set_scene_status' and args.get('status')=='deleted'):
            for ref in resolved:
                source=writer.store.add_source(ref['source_key'],ref['content'],metadata=ref['metadata'])
                old=db.execute('SELECT active,metadata_json FROM evidence_bindings WHERE document_id=? AND source_id=?',
                               (key,source)).fetchone()
                if old is None or not old['active'] or json.loads(old['metadata_json'])!=ref['metadata']:
                    writer.store.bind(key,source,metadata=ref['metadata'],actor='morrow_host_context')
        map_evidence_ids(writer.store,[key])
        response={'ok':True,'id':key,'revision':result['revision'],'status':result['status'],
                  'content':'记忆操作已保存。\n[scene_id:'+key+']\n[evidence_scope:host_context_dependency]'}
        if context_hash:
            response['context_verification']={'version':'morrow-context-binding-v1','digest':context_hash,'epoch':body['epoch']}
        return response


def register(app, settings, projector, token, policy_path):
    from fastapi import Request
    from fastapi.responses import JSONResponse
    # Keep annotations concrete under modules that use postponed annotations.
    async def authorization(request):
        supplied=request.headers.get('authorization','')
        if request.client is None or request.client.host not in ('127.0.0.1','::1','testclient'):
            return JSONResponse({'error':'loopback_required'},status_code=403)
        if request.headers.get('origin') or not hmac.compare_digest(supplied.encode(),('Bearer '+token).encode()):
            return JSONResponse({'error':'authentication_required'},status_code=401)
        return None

    async def dispatch(request, operation):
        rejected=await authorization(request)
        if rejected is not None:return rejected
        try:
            if int(request.headers.get('content-length','0'))>1024*1024:
                return JSONResponse({'error':'request_too_large'},status_code=413)
            data=await request.body()
            if len(data)>1024*1024:return JSONResponse({'error':'request_too_large'},status_code=413)
            body=json.loads(data)
            p=policy(policy_path)
            if operation=='capabilities':
                if body!={}:raise ValueError()
                return {'protocol':PROTOCOL,'guard':guard.VERSION,'source_enabled':p['enabled'],
                        'automatic_events_enabled':False,'certified':False}
            if not p['enabled']:return JSONResponse({'error':'source_receiver_closed'},status_code=503)
            if not isinstance(body,dict) or body.get('instance_id')!=p['instance_id']:
                return JSONResponse({'error':'source_instance_mismatch'},status_code=403)
            # Blocking database work belongs on a worker, never the event loop.
            from starlette.concurrency import run_in_threadpool
            if operation=='status':
                if set(body)!={'instance_id'}:raise ValueError()
                head=await run_in_threadpool(projector.head,p['instance_id'])
                return {**head,'epoch':guard.current(settings.database)}
            if operation=='events':return await run_in_threadpool(projector.apply,body)
            if operation=='scene':return await run_in_threadpool(author_scene,settings,body,host_key=token,require_context=True)
            raise ValueError()
        except SourceConflict:
            return JSONResponse({'error':'source_conflict_review_required'},status_code=409)
        except (ValueError,TypeError,KeyError):
            return JSONResponse({'error':'invalid_source_request'},status_code=400)
        except sqlite3.Error:
            return JSONResponse({'error':'source_storage_rejected'},status_code=409)

    import sqlite3
    for path,operation in (('capabilities','capabilities'),('source-status','status'),('source-events','events'),('scene','scene')):
        def endpoint_for(op):
            async def endpoint(request: Request):
                return await dispatch(request,op)
            return endpoint
        app.add_api_route('/bridge/'+path,endpoint_for(operation),methods=['POST'])

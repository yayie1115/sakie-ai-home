import {Router} from 'express';
import express from 'express';
import type {ArchiveIdentity,SyncProofCursor,SyncResumeRequest} from '@sakie/contracts';
import {SyncService,SyncError} from './service.js';
import {objectBody,ValidationError} from '../../shared/validation.js';
const uuid=(v:unknown)=>{if(typeof v!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v))throw new ValidationError('Invalid identity');return v;};
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER)=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw new ValidationError('Invalid sequence');return v;};
function archive(v:unknown):ArchiveIdentity{const b=objectBody(v);return{archiveId:uuid(b.archiveId),restoreGeneration:uuid(b.restoreGeneration)};}
function cursor(v:unknown):SyncProofCursor {const b=objectBody(v);if(typeof b.streamId!=='string'||b.streamId.length>100||b.durability!=='committed')throw new ValidationError('Invalid cursor');if(b.lastEventId!==null)uuid(b.lastEventId);if(b.lastPayloadHash!==null&&(typeof b.lastPayloadHash!=='string'||!/^[a-f0-9]{64}$/.test(b.lastPayloadHash)))throw new ValidationError('Invalid cursor proof');return{streamId:b.streamId,contiguousSeq:integer(b.contiguousSeq),archive:archive(b.archive),durability:'committed',lastEventId:b.lastEventId as string|null,lastPayloadHash:b.lastPayloadHash as string|null};}
export function syncRouter(service:SyncService){
 const router=Router();router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});router.use(express.json({limit:'16kb'}));
 const failures=new Map<string,{n:number;until:number}>();
 router.post('/pair',(req,res)=>{
  const now=Date.now();for(const[k,v]of failures)if(v.until<=now)failures.delete(k);
  const ip=req.ip??'unknown',old=failures.get(ip);
  if((old?.n??0)>=8||(!old&&failures.size>=1024))throw new SyncError(429,'PAIRING_RATE_LIMITED');
  failures.set(ip,{n:(old?.n??0)+1,until:old?.until??now+600000});
  const body=objectBody(req.body);if(typeof body.pairingCode!=='string'||body.pairingCode.length>100)throw new SyncError(401,'INVALID_PAIRING');
  const result=service.pair(body.pairingCode,archive(body.archive));failures.delete(ip);res.status(201).json(result);
 });
 router.use((req,res,next)=>{const header=req.get('authorization')??'';const device=header.startsWith('Bearer ')?service.device(header.slice(7)):null;if(!device)throw new SyncError(401,'DEVICE_UNAUTHENTICATED');res.locals.device=device;next();});
 router.post('/resume',(req,res)=>{const body=objectBody(req.body);const request:SyncResumeRequest={archive:archive(body.archive),lastArchived:body.lastArchived===null?null:cursor(body.lastArchived)};res.json(service.resume(res.locals.device,request));});
 router.post('/pull',(req,res)=>{const body=objectBody(req.body);res.json(service.pull(res.locals.device,integer(body.afterSeq),integer(body.limit??50,1,100)));});
 router.post('/ack',(req,res)=>res.json(service.acknowledge(res.locals.device,cursor(req.body))));
 return router;
}
export function deviceRouter(service:SyncService){const router=Router();
 router.post('/pairings',async(_req,res)=>res.status(201).json(await service.createPairing()));
 router.get('/',(_req,res)=>res.json({items:service.db.prepare('SELECT id,archive_id AS archiveId,restore_generation AS restoreGeneration,created_at AS createdAt,revoked_at AS revokedAt,ack_seq AS ackSeq FROM sync_devices ORDER BY created_at').all()}));
 router.post('/:id/revoke',async(req,res)=>{await service.revoke(uuid(req.params.id));res.status(204).end();});
 return router;
}

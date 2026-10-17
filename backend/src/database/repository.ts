import { appendRecordVersion } from '../modules/sync/events.js';
import { previousMutation, saveMutation } from '../modules/sync/mutations.js';
import { SyncError } from '../modules/sync/service.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
export interface RecordDefinition<T extends {id:string}>{table:'memories'|'diaries'|'dreams'|'activities';columns:readonly(keyof T&string)[];sortColumn:keyof T&string;parse(value:unknown):Omit<T,'id'>;}
export class Repository<T extends {id:string}>{
  constructor(private db:DatabaseSync,private definition:RecordDefinition<T>){}
  create(input:Omit<T,'id'>):T{
    const record={...input,id:randomUUID()} as T;const{table,columns}=this.definition;
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare('INSERT INTO '+table+' ('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')').run(...columns.map(column=>record[column] as SQLInputValue));
      this.db.prepare("INSERT INTO record_metadata(resource,record_id,revision,provenance_status) VALUES (?,?,1,'user_recorded')").run(table,record.id);
      appendRecordVersion(this.db,{resource:table,id:record.id,revision:1,record:record as Record<string,unknown>,deletedAt:null});
      this.db.exec('COMMIT');return record;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  revision(id:string):number|undefined{const row=this.db.prepare('SELECT revision FROM record_metadata WHERE resource=? AND record_id=? AND deleted_at IS NULL').get(this.definition.table,id);return row?Number(row.revision):undefined;}
  get(id:string):T|undefined{return this.db.prepare('SELECT r.* FROM '+this.definition.table+' r JOIN record_metadata m ON m.record_id=r.id AND m.resource=? WHERE r.id=? AND m.deleted_at IS NULL').get(this.definition.table,id) as T|undefined;}
  list(limit:number,offset:number){const{table,sortColumn}=this.definition;const from=' FROM '+table+' r JOIN record_metadata m ON m.record_id=r.id AND m.resource=? WHERE m.deleted_at IS NULL';
    const items=this.db.prepare('SELECT r.*'+from+' ORDER BY r.'+sortColumn+' DESC,r.id DESC LIMIT ? OFFSET ?').all(table,limit,offset) as unknown as T[];
    const total=(this.db.prepare('SELECT count(*) AS total'+from).get(table) as{total:number}).total;return{items,total,limit,offset};
  }
  /** User deletion hides the API record; original row is retained. Permanent erasure is a separate future policy. */
  delete(id:string):boolean{
    this.db.exec('BEGIN IMMEDIATE');try{
      const record=this.get(id);if(!record){this.db.exec('COMMIT');return false;}
      const resource=this.definition.table;const meta=this.db.prepare('SELECT revision FROM record_metadata WHERE resource=? AND record_id=?').get(resource,id)!;
      const revision=Number(meta.revision);appendRecordVersion(this.db,{resource,id,revision,record:record as Record<string,unknown>,deletedAt:null});
      const deletedAt=new Date().toISOString();this.db.prepare('UPDATE record_metadata SET deleted_at=?,revision=revision+1 WHERE resource=? AND record_id=?').run(deletedAt,resource,id);
      appendRecordVersion(this.db,{resource,id,revision:revision+1,record:record as Record<string,unknown>,deletedAt});this.db.exec('COMMIT');return true;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  update(id:string,input:Omit<T,'id'>,baseRevision:number,requestId:string):T{
    this.db.exec('BEGIN IMMEDIATE');try{
      const resource=this.definition.table;const supplied={...input} as Record<string,unknown>;if(resource==='memories')delete supplied.createdAt;const request={resource,id,input:supplied,baseRevision};const previous=previousMutation<T>(this.db,requestId,request);if(previous){this.db.exec('COMMIT');return previous;}
      const old=this.get(id);if(!old)throw new SyncError(404,'RECORD_NOT_FOUND');
      const revision=Number(this.db.prepare('SELECT revision FROM record_metadata WHERE resource=? AND record_id=?').get(resource,id)!.revision);
      if(revision!==baseRevision)throw new SyncError(409,'REVISION_CONFLICT');
      appendRecordVersion(this.db,{resource,id,revision,record:old as Record<string,unknown>,deletedAt:null});
      const record={...input,id,...(resource==='memories'?{createdAt:(old as Record<string,unknown>).createdAt}:{})} as T;const columns=this.definition.columns.filter(column=>column!=='id');
      this.db.prepare('UPDATE '+resource+' SET '+columns.map(c=>c+'=?').join(',')+' WHERE id=?').run(...columns.map(c=>record[c] as SQLInputValue),id);
      this.db.prepare('UPDATE record_metadata SET revision=revision+1 WHERE resource=? AND record_id=?').run(resource,id);
      appendRecordVersion(this.db,{resource,id,revision:revision+1,record:record as Record<string,unknown>,deletedAt:null});saveMutation(this.db,requestId,request,record);this.db.exec('COMMIT');return record;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}

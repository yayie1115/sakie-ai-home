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
      this.db.exec('COMMIT');return record;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  get(id:string):T|undefined{return this.db.prepare('SELECT r.* FROM '+this.definition.table+' r JOIN record_metadata m ON m.record_id=r.id AND m.resource=? WHERE r.id=? AND m.deleted_at IS NULL').get(this.definition.table,id) as T|undefined;}
  list(limit:number,offset:number){const{table,sortColumn}=this.definition;const from=' FROM '+table+' r JOIN record_metadata m ON m.record_id=r.id AND m.resource=? WHERE m.deleted_at IS NULL';
    const items=this.db.prepare('SELECT r.*'+from+' ORDER BY r.'+sortColumn+' DESC,r.id DESC LIMIT ? OFFSET ?').all(table,limit,offset) as unknown as T[];
    const total=(this.db.prepare('SELECT count(*) AS total'+from).get(table) as{total:number}).total;return{items,total,limit,offset};
  }
  /** User deletion hides the API record; original row is retained. Permanent erasure is a separate future policy. */
  delete(id:string):boolean{return this.db.prepare('UPDATE record_metadata SET deleted_at=?,revision=revision+1 WHERE resource=? AND record_id=? AND deleted_at IS NULL').run(new Date().toISOString(),this.definition.table,id).changes>0;}
}

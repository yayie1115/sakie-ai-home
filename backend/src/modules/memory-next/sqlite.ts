/** MEM-03 synthetic-only SQLite repository. Never open a production database. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { MemoryPipeline, type Snapshot } from './pipeline.js';
import type { Recall, Memory } from './memory.js';

export class SqliteMemoryLab {
  private db: DatabaseSync;
  private constructor(db: DatabaseSync) { this.db = db; }
  static open(path: string): SqliteMemoryLab {
    // Explicit opt-in for a synthetic testing directory; cannot accidentally open sakie.db.
    const absolute=resolve(path);
    if (!absolute.includes('sakie-mem03-lab-') || !absolute.endsWith('.sqlite') || /(^|[\\/])sakie\.db$/i.test(absolute)) throw Error('synthetic_path_only');
    if (!existsSync(dirname(absolute))) mkdirSync(dirname(absolute),{recursive:true});
    const db=new DatabaseSync(absolute);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
    db.exec(`CREATE TABLE IF NOT EXISTS mem03_snapshot (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mem03_index (id TEXT PRIMARY KEY, owner TEXT NOT NULL, statement TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS mem03_fts USING fts5(id UNINDEXED, statement, tokenize='trigram');`);
    return new SqliteMemoryLab(db);
  }
  close():void { this.db.close(); }
  write(pipeline: MemoryPipeline):void {
    const snap=pipeline.snapshot();
    // Preserve all-or-nothing consistency between the canonical snapshot and derived index.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO mem03_snapshot (id,payload) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(snap));
      this.db.exec('DELETE FROM mem03_fts; DELETE FROM mem03_index;');
      const put=this.db.prepare('INSERT INTO mem03_index (id,owner,statement) VALUES (?,?,?)');
      const fts=this.db.prepare('INSERT INTO mem03_fts (id,statement) VALUES (?,?)');
      for(const c of snap.candidates) { put.run(c.id,c.owner,c.statement); fts.run(c.id,c.statement); }
      this.db.exec('COMMIT');
    }catch(e){ this.db.exec('ROLLBACK'); throw e; }
  }
  load():MemoryPipeline {
    const row=this.db.prepare('SELECT payload FROM mem03_snapshot WHERE id=1').get() as {payload:string}|undefined;
    return row?MemoryPipeline.fromSnapshot(JSON.parse(row.payload) as Snapshot):new MemoryPipeline();
  }
  /** SQLite trigram ranks candidate texts; MemoryPipeline remains authority for access and current versions. */
  recall(actor:string,query:string,limit=5):Recall {
    const pipeline=this.load();
    if(!query.trim()||!Number.isInteger(limit)||limit<1||limit>20) return {status:'no_match',memories:[]};
    // FTS trigram cannot index short search tokens; use guarded in-memory retrieval.
    const q=query.normalize('NFKC').trim();
    if([...q].length<3) return pipeline.recall(actor,q,limit);
    let hits: string[]=[];
    try {
      const escaped=`"${q.replaceAll('"','""')}"`;
      hits=(this.db.prepare('SELECT id FROM mem03_fts WHERE statement MATCH ? LIMIT 100').all(escaped) as {id:string}[]).map(x=>x.id);
    }catch { return pipeline.recall(actor,q,limit); }
    if(!hits.length) return {status:'no_match',memories:[]};
    // Eligibility comes from current source scope, valid version, revision chain and owner.
    const snap=pipeline.snapshot();
    const source=new Map(snap.events.map(e=>[`${e.source.id}::${e.source.version}`,e.source]));
    const current=new Set(snap.candidates.map(c=>c.id));
    for(const c of snap.candidates) if(c.supersedes && current.has(c.supersedes)) {
      const s=source.get(`${c.sourceId}::${c.sourceVersion}`);
      if(s?.active && !s.deleted && s.scope.actors.includes(actor) && c.owner===actor) current.delete(c.supersedes);
    }
    const mapped=new Map(snap.candidates.map(c=>[c.id,c]));
    const results:Memory[]=[];
    for(const id of hits) {
      const c=mapped.get(id);if(!c||!current.has(id)||c.owner!==actor) continue;
      const s=source.get(`${c.sourceId}::${c.sourceVersion}`);
      if(!s||s.deleted||!s.active||!s.scope.actors.includes(actor))continue;
      const {evidenceQuote:_e,...body}=c;
      results.push({...body,createdAt:s.occurredAt});
      if(results.length===limit) break;
    }
    return {status:results.length?'ok':'no_match',memories:results};
  }
  integrity():string {return String((this.db.prepare('PRAGMA integrity_check').get() as {'integrity_check':string}).integrity_check);}
}

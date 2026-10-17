import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPipeline } from '../src/modules/memory-next/pipeline.js';
import { SqliteMemoryLab } from '../src/modules/memory-next/sqlite.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const makeSource=(version:string)=>({id:'msg-1',version,context:'real' as const,scope:{type:'private' as const,actors:['ai-1']},active:true,deleted:false,occurredAt:'2026-10-17T10:00:00.000Z'});
test('edited source invalidates previous text in snapshot and SQLite FTS',()=>{
 const p=new MemoryPipeline();
 p.acceptEvent({eventId:'evt-1',source:makeSource('1'),text:'旧内容提到了樱花旅行'});
 p.acceptCandidate('decision-1',{id:'mem-1',owner:'ai-1',sourceId:'msg-1',sourceVersion:'1',kind:'fact',statement:'樱花旅行',evidenceQuote:'樱花旅行',confidence:1,salience:0.4});
 p.acceptEvent({eventId:'evt-2',source:makeSource('2'),text:'新内容提到了海边旅行'});
 assert.equal(p.recall('ai-1','樱花旅行').status,'no_match');
 const snapshot=p.snapshot();
 assert.equal(snapshot.events.length,1);
 assert.equal(snapshot.events[0].source.version,'2');
 assert.equal(snapshot.candidates.length,0);
 const dir=mkdtempSync(join(tmpdir(),'sakie-mem03-lab-version-'));
 const db=SqliteMemoryLab.open(join(dir,'memory.sqlite'));
 try {db.write(p); assert.equal(db.recall('ai-1','樱花旅行').status,'no_match'); assert.equal(db.load().recall('ai-1','樱花旅行').status,'no_match');}
 finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

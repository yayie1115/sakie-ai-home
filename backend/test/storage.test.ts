import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBackup, restoreBackup, verifyBackup } from '../src/database/backup.js';
import { businessFingerprint, databaseFingerprint } from '../src/database/fingerprint.js';
import { legacySchema } from '../src/database/legacy-schema.js';
import { migrate, migrations, schemaVersion } from '../src/database/migrations.js';
import { upgradeDatabase } from '../src/database/upgrade.js';
import { openDatabase } from '../src/database/index.js';
import { prepareStorage } from '../src/storage/prepare.js';
import { parseConfig, repositoryRoot } from '../src/config/env.js';
import { temporaryDirectory } from './helpers.js';
function fixture(directory:string){
 const filename=join(directory,'legacy.db');const db=new DatabaseSync(filename);db.exec(legacySchema);db.exec('PRAGMA user_version=1');
 db.prepare('INSERT INTO memories VALUES (?,?,?,?,?)').run('11111111-1111-4111-8111-111111111111','  原始记忆，保留空白  ','preference','2025-01-01T00:00:00.000Z',5);
 db.prepare('INSERT INTO diaries VALUES (?,?,?)').run('22222222-2222-4222-8222-222222222222','2025-01-01','旧日记');
 db.prepare('INSERT INTO dreams VALUES (?,?,?,?)').run('33333333-3333-4333-8333-333333333333','2025-01-02','旧梦境','user');
 db.prepare('INSERT INTO activities VALUES (?,?,?,?)').run('44444444-4444-4444-8444-444444444444','2025-01-02T00:00:00.000Z','test','旧活动');
 db.exec('CREATE TABLE extra_preserved (id TEXT PRIMARY KEY, payload BLOB) STRICT');db.prepare('INSERT INTO extra_preserved VALUES (?,?)').run('extra',Buffer.from([0,255,17]));
 const original=databaseFingerprint(db);const business=businessFingerprint(db);db.close();return{filename,original,business};
}
test('consistent backup restores historical SQLite and quiesced media into a new directory',async()=>{
 const dir=temporaryDirectory();try{
  const source=fixture(dir);const media=join(dir,'media');mkdirSync(join(media,'images'),{recursive:true});writeFileSync(join(media,'images','history.bin'),Buffer.from([1,2,3,255]));
  await assert.rejects(createBackup(source.filename,join(dir,'backups'),{mediaDir:media}),/quiesced/);
  const snapshot=await createBackup(source.filename,join(dir,'backups'),{mediaDir:media,mediaQuiesced:true});const manifest=await verifyBackup(snapshot);assert.equal(manifest.files.length,2);
  const restored=await restoreBackup(snapshot,join(dir,'recovery'));const db=new DatabaseSync(restored,{readOnly:true});try{assert.equal(databaseFingerprint(db),source.original);}finally{db.close();}
  assert.deepEqual(readFileSync(join(dir,'recovery','media','images','history.bin')),Buffer.from([1,2,3,255]));
  assert.equal(JSON.parse(readFileSync(join(dir,'recovery','restore-info.json'),'utf8')).requiresArchiveReconciliation,true);
  await assert.rejects(prepareStorage({dataDir:join(dir,'recovery'),databasePath:restored,backupDir:join(dir,'backups')}),/quarantined/);
  await assert.rejects(restoreBackup(snapshot,join(dir,'recovery')),/refusing to overwrite/);
  assert.equal(readFileSync(join(dir,'recovery','media','images','history.bin'))[3],255);
  writeFileSync(join(snapshot,'media','images','history.bin'),'tampered');await assert.rejects(verifyBackup(snapshot),/verification failed/);
 }finally{rmSync(dir,{recursive:true});}
});
test('malicious backup paths and corrupt packages are rejected before a restore directory is created',async()=>{
 const dir=temporaryDirectory();try{
  const source=fixture(dir);const snapshot=await createBackup(source.filename,join(dir,'backups'));const manifest=JSON.parse(readFileSync(join(snapshot,'manifest.json'),'utf8'));
  manifest.files[0].path='media/../../escape';writeFileSync(join(snapshot,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(restoreBackup(snapshot,join(dir,'must-not-exist')),/Unsafe backup path/);assert.equal(existsSync(join(dir,'must-not-exist')),false);
 }finally{rmSync(dir,{recursive:true});}
});
test('v1 upgrade makes verified backup and rehearsal, preserves all business UUIDs and content, and repeats safely',async()=>{
 const dir=temporaryDirectory();try{
  const source=fixture(dir);assert.throws(()=>openDatabase(source.filename),/upgrade required/);
  const result=await upgradeDatabase(source.filename,join(dir,'backups'));assert.equal(result.changed,true);assert.ok(result.backupDirectory);assert.ok(result.rehearsalDatabase);await verifyBackup(result.backupDirectory);
  const db=openDatabase(source.filename);try{
   assert.equal(schemaVersion(db),2);assert.equal(businessFingerprint(db),source.business);
   assert.equal(db.prepare('SELECT content FROM memories WHERE id=?').get('11111111-1111-4111-8111-111111111111')?.content,'  原始记忆，保留空白  ');
   assert.equal(db.prepare('SELECT count(*) AS n FROM record_metadata').get()?.n,4);
   assert.equal(db.prepare("SELECT provenance_status FROM record_metadata WHERE record_id='11111111-1111-4111-8111-111111111111'").get()?.provenance_status,'legacy_unverified');
   assert.deepEqual(db.prepare('SELECT payload FROM extra_preserved').get()?.payload,new Uint8Array([0,255,17]));
   assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n,2);
  }finally{db.close();}
  assert.deepEqual(await upgradeDatabase(source.filename,join(dir,'backups')),{changed:false});
  const corrupt=new DatabaseSync(source.filename);corrupt.exec("UPDATE schema_migrations SET checksum='changed' WHERE version=1");corrupt.close();
  await assert.rejects(upgradeDatabase(source.filename,join(dir,'backups')),/checksum mismatch/);
 }finally{rmSync(dir,{recursive:true});}
});
test('failed migration and injected exception roll back schema, history and every original record',()=>{
 const dir=temporaryDirectory();try{
  const source=fixture(dir);const db=new DatabaseSync(source.filename);
  try{
   assert.throws(()=>migrate(db,[migrations[0],{version:2,name:'broken',sql:'CREATE TABLE should_rollback(id TEXT); INVALID SQL;'}]));
   assert.equal(databaseFingerprint(db),source.original);assert.equal(schemaVersion(db),1);
   assert.throws(()=>migrate(db,undefined,{afterStep:()=>{throw new Error('injected failure');}}),/injected failure/);
   assert.equal(databaseFingerprint(db),source.original);assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='auth_sessions'").get(),undefined);
  }finally{db.close();}
 }finally{rmSync(dir,{recursive:true});}
});
test('process termination during an actual migration leaves a recoverable original v1 database',()=>{
 const dir=temporaryDirectory();try{
  const source=fixture(dir);
  const script="import {DatabaseSync} from 'node:sqlite';import {migrate} from "+JSON.stringify(new URL('../src/database/migrations.ts',import.meta.url).href)+";const db=new DatabaseSync("+JSON.stringify(source.filename)+");migrate(db,undefined,{afterStep:()=>process.exit(77)});";
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:repositoryRoot,encoding:'utf8',timeout:15000});assert.equal(child.status,77);
  const db=new DatabaseSync(source.filename);try{assert.equal(databaseFingerprint(db),source.original);assert.equal(schemaVersion(db),1);assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');migrate(db);assert.equal(schemaVersion(db),2);assert.equal(businessFingerprint(db),source.business);}finally{db.close();}
 }finally{rmSync(dir,{recursive:true});}
});
test('legacy import uses an independent external copy and never upgrades or overwrites the old file',async()=>{
 const dir=temporaryDirectory();try{
  const source=fixture(dir);const settings={dataDir:join(dir,'runtime'),databasePath:join(dir,'runtime','sakie.db'),backupDir:join(dir,'backups')};
  await assert.rejects(prepareStorage(settings,{legacyPath:source.filename}),/Legacy database retained/);
  const result=await prepareStorage(settings,{legacyPath:source.filename,importLegacy:true});assert.equal(result.imported,true);
  const original=new DatabaseSync(source.filename,{readOnly:true});const target=openDatabase(settings.databasePath);try{assert.equal(schemaVersion(original),1);assert.equal(databaseFingerprint(original),source.original);assert.equal(schemaVersion(target),2);assert.equal(businessFingerprint(target),source.business);}finally{original.close();target.close();}
  assert.deepEqual(await prepareStorage(settings,{legacyPath:source.filename,importLegacy:true}),{created:false,imported:false});
 }finally{rmSync(dir,{recursive:true});}
});
test('new startup storage and configuration support unchanged dev commands and fail closed for unsafe production settings',async()=>{
 const dir=temporaryDirectory();try{
  const settings={dataDir:join(dir,'fresh'),databasePath:join(dir,'fresh','sakie.db'),backupDir:join(dir,'backups')};
  await prepareStorage(settings,{legacyPath:join(dir,'absent.db')});const db=openDatabase(settings.databasePath);db.close();
  assert.equal(parseConfig({}).port,3000);assert.equal(parseConfig({}).runtimeRole,'cloud');assert.ok(!parseConfig({}).dataDir.startsWith(repositoryRoot));
  assert.throws(()=>parseConfig({NODE_ENV:'production'}),/HTTPS/);assert.throws(()=>parseConfig({NODE_ENV:'production',PUBLIC_ORIGIN:'http://sakiehome.icu'}),/HTTPS/);
  assert.equal(parseConfig({NODE_ENV:'production',PUBLIC_ORIGIN:'https://sakiehome.icu'}).secureCookies,true);
  assert.throws(()=>parseConfig({DATA_DIR:join(repositoryRoot,'frontend','dist','data')}),/outside/);
  assert.throws(()=>parseConfig({RUNTIME_ROLE:'invalid'}));assert.throws(()=>parseConfig({DATA_DIR:''}));
 }finally{rmSync(dir,{recursive:true});}
});

test('online backup includes committed WAL records and excludes an uncommitted transaction',async()=>{
 const dir=temporaryDirectory();try{
  const source=fixture(dir);const writer=new DatabaseSync(source.filename);writer.exec('PRAGMA journal_mode=WAL');
  writer.prepare('INSERT INTO diaries VALUES (?,?,?)').run('committed-wal-id','2026-10-15','committed WAL content');
  writer.exec('BEGIN IMMEDIATE');writer.prepare('INSERT INTO diaries VALUES (?,?,?)').run('uncommitted-id','2026-10-15','must not enter snapshot');
  try{
   const snapshot=await createBackup(source.filename,join(dir,'backups'));const restored=await restoreBackup(snapshot,join(dir,'recovery'));const copy=new DatabaseSync(restored,{readOnly:true});
   try{assert.equal(copy.prepare('SELECT content FROM diaries WHERE id=?').get('committed-wal-id')?.content,'committed WAL content');assert.equal(copy.prepare('SELECT 1 FROM diaries WHERE id=?').get('uncommitted-id'),undefined);}finally{copy.close();}
  }finally{writer.exec('ROLLBACK');writer.close();}
 }finally{rmSync(dir,{recursive:true});}
});

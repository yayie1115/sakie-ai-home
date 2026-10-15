import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { databaseFingerprint } from './fingerprint.js';
interface Artifact { path: string; sha256: string; size: number; }
export interface BackupManifest { format: 1; createdAt: string; schemaVersion: number; fingerprint: string; mediaPolicy: 'none' | 'quiesced'; files: Artifact[]; }
async function digest(filename: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }
function safePath(root: string, name: string): string {
  if (!name || name.includes('\\') || name.includes(':') || isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe backup path');
  const target = resolve(root,name); const rel = relative(resolve(root),target);
  if (rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Backup path escapes root');
  let current = resolve(root);
  for (const part of name.split('/')) { current = join(current,part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Symlinks are not permitted in backups'); }
  return target;
}
function inspect(filename: string) {
  const db = new DatabaseSync(filename,{ readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database integrity failed');
    return { fingerprint: databaseFingerprint(db), schemaVersion: (db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version };
  } finally { db.close(); }
}
function mediaFiles(root: string, prefix = ''): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(join(root,prefix),{withFileTypes:true})) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    const full = safePath(root,name);
    if (lstatSync(full).isSymbolicLink()) throw new Error('Media symlinks are not supported');
    if (entry.isDirectory()) results.push(...mediaFiles(root,name));
    else if (entry.isFile()) results.push(name);
    else throw new Error('Unsupported media entry');
  }
  return results.sort();
}
export async function createBackup(source: string, root: string, options: { mediaDir?: string; mediaQuiesced?: boolean } = {}): Promise<string> {
  if (!existsSync(source) || lstatSync(source).isSymbolicLink()) throw new Error('Source database must be an existing regular file');
  if (options.mediaDir && !options.mediaQuiesced) throw new Error('Media writes must be quiesced before backup');
  if (options.mediaDir && (!existsSync(options.mediaDir) || lstatSync(options.mediaDir).isSymbolicLink())) throw new Error('Invalid media directory');
  if (options.mediaDir) { const rel = relative(realpathSync(options.mediaDir),resolve(root)); if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) throw new Error('Backup root cannot be inside media'); }
  mkdirSync(root,{recursive:true});
  const destination = mkdtempSync(join(root,'snapshot-'));
  const sourceDb = new DatabaseSync(source,{readOnly:true});
  try { await backup(sourceDb,join(destination,'database.sqlite')); } finally { sourceDb.close(); }
  const files: Artifact[] = [];
  const capture = async (name: string) => { const full=safePath(destination,name); files.push({path:name,sha256:await digest(full),size:statSync(full).size}); };
  await capture('database.sqlite');
  if (options.mediaDir) {
    const before=mediaFiles(options.mediaDir);
    for (const name of before) {
      const from=safePath(options.mediaDir,name); const to=safePath(destination,'media/'+name);
      const sourceHash=await digest(from); mkdirSync(dirname(to),{recursive:true}); copyFileSync(from,to,constants.COPYFILE_EXCL);
      if (await digest(from) !== sourceHash || await digest(to) !== sourceHash) throw new Error('Media changed during backup');
      await capture('media/'+name);
    }
    if (JSON.stringify(before)!==JSON.stringify(mediaFiles(options.mediaDir))) throw new Error('Media tree changed during backup');
  }
  const info=inspect(join(destination,'database.sqlite'));
  const manifest: BackupManifest = {format:1,createdAt:new Date().toISOString(),...info,mediaPolicy:options.mediaDir?'quiesced':'none',files};
  // A manifest is the completion marker. Failed snapshots are retained without it and cannot be restored.
  writeFileSync(join(destination,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
  await verifyBackup(destination);
  return destination;
}
export async function verifyBackup(directory: string): Promise<BackupManifest> {
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Backup directory must not be a symlink');
  const manifestFile=safePath(directory,'manifest.json');
  if (statSync(manifestFile).size > 10*1024*1024) throw new Error('Manifest too large');
  const value: unknown=JSON.parse(readFileSync(manifestFile,'utf8'));
  if (!value || typeof value!=='object') throw new Error('Invalid manifest');
  const manifest=value as BackupManifest;
  if (manifest.format!==1 || !['none','quiesced'].includes(manifest.mediaPolicy) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length>100000 || !Number.isInteger(manifest.schemaVersion) || !/^[a-f0-9]{64}$/.test(manifest.fingerprint)) throw new Error('Invalid manifest');
  const seen=new Set<string>();
  for (const item of manifest.files) {
    if (!item || typeof item.path!=='string' || (item.path!=='database.sqlite' && !item.path.startsWith('media/')) || seen.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size<0) throw new Error('Invalid artifact');
    seen.add(item.path); const full=safePath(directory,item.path);
    if (!lstatSync(full).isFile() || statSync(full).size!==item.size || await digest(full)!==item.sha256) throw new Error('Backup artifact verification failed');
  }
  if(manifest.mediaPolicy==='none'&&manifest.files.some(item=>item.path.startsWith('media/')))throw new Error('Media policy mismatch');
  if (!seen.has('database.sqlite')) throw new Error('Database artifact missing');
  const info=inspect(join(directory,'database.sqlite'));
  if (info.schemaVersion!==manifest.schemaVersion || info.fingerprint!==manifest.fingerprint) throw new Error('Database manifest mismatch');
  return manifest;
}
/** Always restores to a new directory; never replaces an existing database or directory. */
export async function restoreBackup(directory: string, target: string): Promise<string> {
  const manifest=await verifyBackup(directory);
  if (existsSync(target)) throw new Error('Restore target already exists; refusing to overwrite live/new data');
  mkdirSync(dirname(resolve(target)),{recursive:true}); mkdirSync(target);
  for (const item of manifest.files) {
    const destination=safePath(target,item.path==='database.sqlite'?'sakie.db':item.path);
    mkdirSync(dirname(destination),{recursive:true}); copyFileSync(safePath(directory,item.path),destination,constants.COPYFILE_EXCL);
    if (await digest(destination)!==item.sha256) throw new Error('Restored artifact checksum mismatch');
  }
  const database=join(target,'sakie.db');
  if (inspect(database).fingerprint!==manifest.fingerprint) throw new Error('Restored database differs');
  writeFileSync(join(target,'restore-info.json'),JSON.stringify({restoredAt:new Date().toISOString(),restoreGeneration:randomUUID(),requiresArchiveReconciliation:true,requiresSessionRevocation:true},null,2),{flag:'wx'});
  return database;
}

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createBackup, restoreBackup } from './backup.js';
import { businessFingerprint, databaseFingerprint } from './fingerprint.js';
import { assertMigrationHistory, latestVersion, migrate, schemaVersion } from './migrations.js';
export async function upgradeDatabase(filename: string, backupRoot: string): Promise<{ changed: boolean; backupDirectory?: string; rehearsalDatabase?: string }> {
  if (!existsSync(filename)) throw new Error('Database does not exist');
  const before=new DatabaseSync(filename,{readOnly:true});
  let version: number; let fingerprint: string; let business: string;
  try { version=schemaVersion(before);fingerprint=databaseFingerprint(before);business=businessFingerprint(before); } finally {before.close();}
  if (version>latestVersion) throw new Error('Database schema is newer than application');
  if (version===latestVersion) { const current=new DatabaseSync(filename,{readOnly:true});try { assertMigrationHistory(current); }finally{current.close();} return {changed:false}; }
  const backupDirectory=await createBackup(filename,backupRoot);
  const snapshot=new DatabaseSync(join(backupDirectory,'database.sqlite'),{readOnly:true});try {if(databaseFingerprint(snapshot)!==fingerprint)throw new Error('Source changed while backing up; retry in maintenance mode');}finally{snapshot.close();}
  mkdirSync(join(backupRoot,'rehearsals'),{recursive:true});
  const parent=mkdtempSync(join(backupRoot,'rehearsals','upgrade-'));
  const rehearsalDatabase=await restoreBackup(backupDirectory,join(parent,'candidate'));
  const candidate=new DatabaseSync(rehearsalDatabase);
  try {candidate.exec('PRAGMA foreign_keys=ON');migrate(candidate);if(businessFingerprint(candidate)!==business)throw new Error('Rehearsal changed original business records');}finally{candidate.close();}
  const db=new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    migrate(db,undefined,{beforeApply:()=>{if(databaseFingerprint(db)!==fingerprint)throw new Error('Source changed since verified backup; retry in maintenance mode');},afterStep:()=>{if(businessFingerprint(db)!==business)throw new Error('Migration changed original records');}});
    if(businessFingerprint(db)!==business)throw new Error('Business fingerprint mismatch');
  } finally {db.close();}
  return {changed:true,backupDirectory,rehearsalDatabase};
}

/** Read-only schema compatibility probe for the existing sakie-ai-home backend.
 * Never creates tables, runs migrations, or reads private row contents.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface MemoryCompatibility {
  compatibleForAutomaticMerge: false;
  existingSchemaVersion: number;
  hasLegacyMemories: boolean;
  hasMigrationLedger: boolean;
  hasPrototypeTables: boolean;
  requiresSeparateNamespacedMigration: true;
  reasons: string[];
}

export function inspectMemoryCompatibility(db: DatabaseSync): MemoryCompatibility {
  const versionRow = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as {name:string}[]).map(row=>row.name));
  const legacy = names.has('memories');
  const ledger = names.has('schema_migrations');
  const prototype = ['mem03_snapshot','mem03_index','mem03_fts'].some(name=>names.has(name));
  const reasons = [
    'Prototype JSON snapshot and experimental FTS are not production migration definitions.',
    'Existing backend migrations are checksum-verified; a new migration must be reviewed and versioned.',
    'Current record_metadata and conversation version/sync policies require an explicit integration adapter.'
  ];
  if (legacy) reasons.push('Existing memories business table cannot be replaced or repurposed.');
  if (!ledger && versionRow.user_version>1) reasons.push('Migration ledger missing for a versioned database; stop.');
  if (prototype) reasons.push('Prototype tables already present; do not assume their provenance.');
  return {
    compatibleForAutomaticMerge: false,
    existingSchemaVersion: versionRow.user_version,
    hasLegacyMemories: legacy,
    hasMigrationLedger: ledger,
    hasPrototypeTables: prototype,
    requiresSeparateNamespacedMigration: true,
    reasons
  };
}

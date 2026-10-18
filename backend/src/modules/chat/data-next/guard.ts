import { basename, dirname, join, resolve } from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
export const data01Marker = 'sakie-chat-data01-synthetic-only-v1';
export function assertData01Path(file: string) {
    const dir = dirname(file);
    if (basename(file) !== 'chat-data01-synthetic.db' || !basename(dir).startsWith('chat-data01-lab-') || lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== resolve(dir) || readFileSync(join(dir, 'synthetic-marker.txt'), 'utf8') !== data01Marker)
        throw Error('SYNTHETIC_DATABASE_REQUIRED');
    for (const suffix of ['', '-wal', '-shm']) {
        try {
            const stat = lstatSync(file + suffix);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
                throw Error('LINKED_SYNTHETIC_ASSET');
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
        }
    }
}
export function assertData01Database(db: DatabaseSync) { const file = String(db.prepare('PRAGMA database_list').get()!.file); if (file)
    assertData01Path(file); }

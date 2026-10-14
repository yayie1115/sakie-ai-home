import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export interface RecordDefinition<T extends { id: string }> {
  table: 'memories' | 'diaries' | 'dreams' | 'activities';
  columns: readonly (keyof T & string)[];
  sortColumn: keyof T & string;
  parse(value: unknown): Omit<T, 'id'>;
}
export class Repository<T extends { id: string }> {
  constructor(private db: DatabaseSync, private definition: RecordDefinition<T>) {}
  create(input: Omit<T, 'id'>): T {
    const record = { ...input, id: randomUUID() } as T;
    const { table, columns } = this.definition;
    const values = columns.map(column => record[column] as SQLInputValue);
    this.db.prepare('INSERT INTO ' + table + ' (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')').run(...values);
    return record;
  }
  get(id: string): T | undefined {
    return this.db.prepare('SELECT * FROM ' + this.definition.table + ' WHERE id = ?').get(id) as T | undefined;
  }
  list(limit: number, offset: number) {
    const { table, sortColumn } = this.definition;
    const items = this.db.prepare('SELECT * FROM ' + table + ' ORDER BY ' + sortColumn + ' DESC, id DESC LIMIT ? OFFSET ?').all(limit, offset) as unknown as T[];
    const total = (this.db.prepare('SELECT count(*) AS total FROM ' + table).get() as { total: number }).total;
    return { items, total, limit, offset };
  }
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM ' + this.definition.table + ' WHERE id = ?').run(id).changes > 0;
  }
}

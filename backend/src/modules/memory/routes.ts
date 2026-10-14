import type { DatabaseSync } from 'node:sqlite';
import { recordRouter } from '../../shared/record-router.js';
import { objectBody, text, importance } from '../../shared/validation.js';
import type { Memory } from './model.js';
export const memoryRouter = (db: DatabaseSync) => recordRouter<Memory>(db, {
  table: 'memories', columns: ['id', 'content', 'type', 'createdAt', 'importance'], sortColumn: 'createdAt',
  parse(value) { const body = objectBody(value); return { content: text(body.content, 'content'), type: text(body.type, 'type', 100), importance: importance(body.importance), createdAt: new Date().toISOString() }; },
});

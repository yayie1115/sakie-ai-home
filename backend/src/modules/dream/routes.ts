import type { DatabaseSync } from 'node:sqlite';
import { recordRouter } from '../../shared/record-router.js';
import { objectBody, text, date, ValidationError } from '../../shared/validation.js';
import type { Dream } from './model.js';
export const dreamRouter = (db: DatabaseSync) => recordRouter<Dream>(db, {
  table: 'dreams', columns: ['id', 'date', 'content', 'source'], sortColumn: 'date',
  parse(value) {
    const body = objectBody(value);
    if (body.source !== 'ai' && body.source !== 'user') throw new ValidationError('source must be ai or user');
    return { content: text(body.content, 'content'), date: date(body.date), source: body.source };
  },
});

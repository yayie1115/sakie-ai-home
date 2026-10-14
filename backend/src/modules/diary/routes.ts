import type { DatabaseSync } from 'node:sqlite';
import { recordRouter } from '../../shared/record-router.js';
import { objectBody, text, date } from '../../shared/validation.js';
import type { Diary } from './model.js';
export const diaryRouter = (db: DatabaseSync) => recordRouter<Diary>(db, {
  table: 'diaries', columns: ['id', 'date', 'content'], sortColumn: 'date',
  parse(value) { const body = objectBody(value); return { content: text(body.content, 'content'), date: date(body.date) }; },
});

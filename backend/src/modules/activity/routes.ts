import type { DatabaseSync } from 'node:sqlite';
import { recordRouter } from '../../shared/record-router.js';
import { objectBody, text, timestamp } from '../../shared/validation.js';
import type { Activity } from './model.js';
export const activityRouter = (db: DatabaseSync) => recordRouter<Activity>(db, {
  table: 'activities', columns: ['id', 'time', 'type', 'content'], sortColumn: 'time',
  parse(value) { const body = objectBody(value); return { content: text(body.content, 'content'), type: text(body.type, 'type', 100), time: timestamp(body.time) }; },
});

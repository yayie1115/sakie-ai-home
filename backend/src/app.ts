import express, { type ErrorRequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { ValidationError } from './shared/validation.js';
import { memoryRouter } from './modules/memory/routes.js';
import { diaryRouter } from './modules/diary/routes.js';
import { dreamRouter } from './modules/dream/routes.js';
import { activityRouter } from './modules/activity/routes.js';

export function createApp(db: DatabaseSync) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok', service: 'sakie-ai-home' }); });
  app.use('/api/memories', memoryRouter(db));
  app.use('/api/diaries', diaryRouter(db));
  app.use('/api/dreams', dreamRouter(db));
  app.use('/api/activities', activityRouter(db));
  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = typeof error.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) console.error(error);
    res.status(status).json({ error: status === 500 ? 'INTERNAL_SERVER_ERROR' : 'INVALID_REQUEST', ...(error instanceof ValidationError ? { message: error.message } : {}) });
  };
  app.use(errorHandler);
  return app;
}

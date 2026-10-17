import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { Repository, type RecordDefinition } from '../database/repository.js';
import { pageNumber, objectBody, ValidationError } from './validation.js';

export function recordRouter<T extends { id: string }>(db: DatabaseSync, definition: RecordDefinition<T>) {
  const router = Router();
  const repository = new Repository(db, definition);
  router.post('/', (req, res) => {
    const record = repository.create(definition.parse(req.body));
    res.location(req.baseUrl + '/' + record.id).status(201).json(record);
  });
  router.put('/:id',(req,res)=>{
    const body=objectBody(req.body);if(!Number.isSafeInteger(body.baseRevision)||Number(body.baseRevision)<1||typeof body.requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(body.requestId))throw new ValidationError('Invalid revision or request ID');
    res.json(repository.update(req.params.id,definition.parse(body.record),Number(body.baseRevision),body.requestId));
  });
  router.get('/', (req, res) => {
    const limit = pageNumber(req.query.limit, 20, 'limit', 1, 100);
    const offset = pageNumber(req.query.offset, 0, 'offset', 0, Number.MAX_SAFE_INTEGER);
    res.json(repository.list(limit, offset));
  });
  router.get('/:id', (req, res) => {
    const record = repository.get(req.params.id);
    if (!record) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    res.setHeader('X-Record-Revision',String(repository.revision(req.params.id)));
    res.json(record);
  });
  router.delete('/:id', (req, res) => {
    if (!repository.delete(req.params.id)) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    res.status(204).end();
  });
  return router;
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/database/index.js';
import { createTestApp as createApp, authenticatedFetch, temporaryDirectory } from './helpers.js';

test('four modules support persistent create, list, read and delete', async () => {
  const directory = temporaryDirectory();
  const filename = join(directory, 'records.db');
  let db = openDatabase(filename);
  let server = createApp(db).listen(0, '127.0.0.1');
  await once(server, 'listening');
  function baseUrl() { const address = server.address(); assert.ok(address && typeof address !== 'string'); return 'http://127.0.0.1:' + address.port; }
  async function stop() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); db.close(); }
  const request = await authenticatedFetch(baseUrl);
  const input = {
    memories: { content: "长期记忆 '); DROP TABLE memories; --", type: 'preference', importance: 5 },
    diaries: { content: '今天的日记', date: '2026-10-14' },
    dreams: { content: '用户记录的梦', date: '2026-10-14', source: 'user' },
    activities: { content: '开始开发', type: 'development', time: '2026-10-14T20:00:00+08:00' },
  };
  const ids: Record<string, string> = {};
  try {
    for (const [resource, body] of Object.entries(input)) {
      const response = await request(baseUrl() + '/api/' + resource, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 201);
      const record = await response.json();
      assert.match(record.id, /^[0-9a-f-]{36}$/);
      assert.equal(record.content, body.content);
      if (resource === 'memories') { assert.equal(record.importance, 5); assert.ok(Number.isFinite(Date.parse(record.createdAt))); }
      if (resource === 'activities') assert.equal(record.time, '2026-10-14T12:00:00.000Z');
      ids[resource] = record.id;
      assert.equal(response.headers.get('location'), '/api/' + resource + '/' + record.id);
    }
    // Simulate process restart by closing and reopening the same database and application.
    await stop();
    db = openDatabase(filename);
    server = createApp(db).listen(0, '127.0.0.1');
    await once(server, 'listening');
    for (const [resource, id] of Object.entries(ids)) {
      const list = await (await request(baseUrl() + '/api/' + resource + '?limit=1&offset=0')).json();
      assert.equal(list.total, 1); assert.equal(list.items[0].id, id);
      assert.equal((await (await request(baseUrl() + '/api/' + resource + '/' + id)).json()).id, id);
      const next = await (await request(baseUrl() + '/api/' + resource + '?limit=1&offset=1')).json();
      assert.equal(next.items.length, 0); assert.equal(next.total, 1);
      assert.equal((await request(baseUrl() + '/api/' + resource + '/' + id, { method: 'DELETE' })).status, 204);
      assert.equal((await request(baseUrl() + '/api/' + resource + '/' + id)).status, 404);
      assert.equal((await request(baseUrl() + '/api/' + resource + '/' + id, { method: 'DELETE' })).status, 404);
    }
    await stop();
    db = openDatabase(filename);
    server = createApp(db).listen(0, '127.0.0.1');
    await once(server, 'listening');
    for (const resource of Object.keys(ids)) assert.equal((await (await request(baseUrl() + '/api/' + resource)).json()).total, 0);
  } finally { await stop(); rmSync(directory, { recursive: true }); }
});

test('validation prevents malformed bodies, dates, sources and pagination from being stored', async () => {
  const db = openDatabase(':memory:');
  const server = createApp(db).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  const request = await authenticatedFetch(() => base);
  const cases: [string, unknown][] = [
    ['memories', null], ['memories', []], ['memories', {}],
    ['memories', { content: ' ', type: 'test', importance: 3 }],
    ['memories', { content: 'x', type: 'test', importance: 6 }],
    ['memories', { content: 'x', type: 'test', importance: '3' }],
    ['diaries', { content: 'x', date: '2026-02-30' }],
    ['diaries', { content: 'x', date: '2026-2-1' }],
    ['dreams', { content: 'x', date: '2026-10-14', source: 'unknown' }],
    ['activities', { content: 'x', type: 'test', time: '2026-10-14T12:00:00' }],
    ['activities', { content: 'x', type: 'test', time: '2026-02-30T12:00:00Z' }],
    ['activities', { content: 'x', type: 'test', time: '2026-10-14T25:00:00Z' }],
  ];
  try {
    for (const [resource, body] of cases) {
      const response = await request(base + '/api/' + resource, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc', 'limit=1&limit=2']) assert.equal((await request(base + '/api/memories?' + query)).status, 400);
    for (const resource of ['memories', 'diaries', 'dreams', 'activities']) assert.equal((await (await request(base + '/api/' + resource)).json()).total, 0);
    const valid = await request(base + '/api/dreams', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '导入的 AI 梦境', date: '2024-02-29', source: 'ai' }) });
    assert.equal(valid.status, 201);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); db.close(); }
});

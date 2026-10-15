import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/database/index.js';
import { createTestApp as createApp, authenticatedFetch } from './helpers.js';
import { parseConfig } from '../src/config/env.js';

test('health endpoint, missing routes and malformed JSON', async () => {
  const db = openDatabase(':memory:');
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const request = await authenticatedFetch(() => base);
    const health = await request(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', service: 'sakie-ai-home' });
    assert.equal((await request(`${base}/api/chat`)).status, 404);
    const invalid = await request(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(invalid.status, 400);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); db.close(); }
});

test('invalid configuration fails early', () => {
  for (const port of ['0', '65536', 'abc', '1.5', '']) assert.throws(() => parseConfig({ PORT: port }));
  assert.equal(parseConfig({}).port, 3000);
  assert.throws(() => parseConfig({ NODE_ENV: 'unknown' }));
});

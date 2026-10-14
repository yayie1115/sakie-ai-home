import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function parseConfig(env: NodeJS.ProcessEnv) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('Invalid NODE_ENV');
  const host = env.HOST ?? '127.0.0.1';
  if (!host.trim()) throw new Error('HOST must not be empty');
  const rawPath = env.DATABASE_PATH ?? fileURLToPath(new URL('../../data/sakie.db', import.meta.url));
  if (!rawPath.trim()) throw new Error('DATABASE_PATH must not be empty');
  const databasePath = rawPath === ':memory:' ? rawPath : resolve(rawPath);
  return Object.freeze({ port, host, nodeEnv, databasePath });
}

export const config = parseConfig(process.env);

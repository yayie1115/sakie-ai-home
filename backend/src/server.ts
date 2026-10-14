import { createApp } from './app.js';
import { config } from './config/env.js';
import { openDatabase } from './database/index.js';

const db = openDatabase(config.databasePath);
const server = createApp(db).listen(config.port, config.host, () => {
  console.log('API listening on http://' + config.host + ':' + config.port);
});
server.on('error', (error) => { console.error(error); db.close(); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  });
}

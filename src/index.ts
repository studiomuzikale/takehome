import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { buildApp } from './http/app.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = buildApp(pool, config.hmacSecret, {
  logLevel: config.logLevel
});

const shutdown = async () => {
  await app.close();
  await pool.end();
};

process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));

app.listen({ host: '0.0.0.0', port: config.port }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

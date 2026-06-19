import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './pool.js';
import { loadConfig } from '../config.js';

export async function migrate(connectionString = loadConfig().databaseUrl): Promise<void> {
  const pool = createPool(connectionString);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = await readFile(resolve(process.cwd(), 'sql/schema.sql'), 'utf8').catch(() =>
      readFile(resolve(here, '../../sql/schema.sql'), 'utf8')
    );
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

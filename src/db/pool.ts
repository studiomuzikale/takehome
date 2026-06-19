import pg from 'pg';

pg.types.setTypeParser(20, (value) => Number(value));

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_SIZE ?? 20),
    idleTimeoutMillis: 30_000
  });
}

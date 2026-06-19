import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://yeet:yeet@localhost:5432/yeet';
const pool = createPool(databaseUrl);

describe('partitioned ledger schema', () => {
  beforeAll(async () => {
    await migrate(databaseUrl);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('keeps action idempotency global while partitioning action history by month', async () => {
    const partitioned = await pool.query<{ relkind: string }>(
      "SELECT relkind FROM pg_class WHERE oid = 'actions'::regclass"
    );
    expect(partitioned.rows[0].relkind).toBe('p');

    const registry = await pool.query<{ constraint_name: string }>(
      `
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'action_registry'
          AND constraint_type = 'PRIMARY KEY'
      `
    );
    expect(registry.rows[0].constraint_name).toBe('action_registry_pkey');

    const partitions = await pool.query<{ child_partition: string }>(
      `
        SELECT inhrelid::regclass::text AS child_partition
        FROM pg_inherits
        WHERE inhparent = 'actions'::regclass
        ORDER BY child_partition
      `
    );
    expect(partitions.rows.map((row) => row.child_partition)).toContain('actions_default');
    expect(partitions.rows.some((row) => /^actions_\d{4}_\d{2}$/.test(row.child_partition))).toBe(true);

    const accountHashIndexes = await pool.query<{ indexname: string }>(
      `
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'actions'
          AND indexname = 'actions_account_hash_created_idx'
      `
    );
    expect(accountHashIndexes.rowCount).toBe(1);
  });
});

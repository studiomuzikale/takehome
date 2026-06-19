import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';

const config = loadConfig();
const users = Number(process.env.SEED_USERS ?? 1000);
const balance = Number(process.env.SEED_BALANCE ?? 100_000_000);
const currency = process.env.SEED_CURRENCY ?? 'USD';

async function main() {
  await migrate(config.databaseUrl);
  const pool = createPool(config.databaseUrl);
  try {
    for (let offset = 0; offset < users; offset += 1000) {
      const batchSize = Math.min(1000, users - offset);
      const values: string[] = [];
      const params: Array<string | number> = [];

      for (let i = 0; i < batchSize; i += 1) {
        params.push(`runner-user-${offset + i}`, currency, balance);
        const base = i * 3;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      }

      await pool.query(
        `
          INSERT INTO accounts (user_id, currency, balance)
          VALUES ${values.join(', ')}
          ON CONFLICT (user_id, currency) DO UPDATE SET
            balance = EXCLUDED.balance,
            updated_at = now()
        `,
        params
      );
    }

    await pool.query(
      `
        INSERT INTO accounts (user_id, currency, balance)
        VALUES ('8|USDT|USD', 'USD', 74322001)
        ON CONFLICT (user_id, currency) DO UPDATE SET balance = EXCLUDED.balance
      `
    );

    console.log(`seeded ${users} runner users with ${balance} ${currency}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

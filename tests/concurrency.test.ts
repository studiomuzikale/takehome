import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/http/app.js';
import { currency, game, resetFixture, secret, signedPost, userId } from './helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://yeet:yeet@localhost:5432/yeet';
const pool = createPool(databaseUrl);
const app = buildApp(pool, secret, 'silent');

describe('concurrency', () => {
  beforeAll(async () => {
    await migrate(databaseUrl);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('K. Concurrent bets against one account cannot both spend the same balance', async () => {
    await resetFixture(pool, 100);

    const [first, second] = await Promise.all([
      signedPost(app, {
        user_id: userId,
        currency,
        game,
        game_id: 'concurrency:1',
        actions: [{ action: 'bet', action_id: '2fecb6e3-61e9-4d1a-86d7-8a67cc87eb34', amount: 100 }]
      }),
      signedPost(app, {
        user_id: userId,
        currency,
        game,
        game_id: 'concurrency:2',
        actions: [{ action: 'bet', action_id: '9d7438a8-ece2-4598-84d0-a1e271a56e15', amount: 100 }]
      })
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 422]);

    const lookup = await signedPost(app, { user_id: userId, currency, game });
    expect(lookup.json()).toEqual({ balance: 0 });
  });
});

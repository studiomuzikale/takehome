import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/http/app.js';
import { drainRtpOutboxUntilEmpty } from '../src/reports/rtp-outbox.js';
import { currency, game, resetFixture, secret, signedGet, signedPost, userId } from './helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://yeet:yeet@localhost:5432/yeet';
const pool = createPool(databaseUrl);
const app = buildApp(pool, secret, 'silent');

describe('RTP reporting', () => {
  beforeAll(async () => {
    await migrate(databaseUrl);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('excludes rolled-back bet/win amounts from RTP and reports them separately', async () => {
    await resetFixture(pool, 1000);
    const from = encodeURIComponent(new Date(Date.now() - 60_000).toISOString());

    await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: 'report:1',
      finished: true,
      actions: [
        { action: 'bet', action_id: 'f1e9f883-2c08-4e38-980d-ff89feaf4001', amount: 100 },
        { action: 'win', action_id: 'f1e9f883-2c08-4e38-980d-ff89feaf4002', amount: 250 }
      ]
    });

    await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: 'report:1',
      finished: true,
      actions: [
        {
          action: 'rollback',
          action_id: 'f1e9f883-2c08-4e38-980d-ff89feaf4003',
          original_action_id: 'f1e9f883-2c08-4e38-980d-ff89feaf4002'
        }
      ]
    });

    await drainRtpOutboxUntilEmpty(pool);

    const to = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    const response = await signedGet(app, `/reports/rtp/users?from=${from}&to=${to}&currency=${currency}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      {
        user_id: userId,
        currency,
        rounds: 1,
        total_bet: 100,
        total_win: 0,
        rollback_count: 1,
        rolled_back_bet: 0,
        rolled_back_win: 250,
        rtp: 0
      }
    ]);
  });
});

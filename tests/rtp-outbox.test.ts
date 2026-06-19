import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/http/app.js';
import { drainRtpOutbox } from '../src/reports/rtp-outbox.js';
import { currency, game, resetFixture, secret, signedPost, userId } from './helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://yeet:yeet@localhost:5432/yeet';
const pool = createPool(databaseUrl);
const app = buildApp(pool, secret, 'silent');

describe('RTP outbox', () => {
  beforeAll(async () => {
    await migrate(databaseUrl);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('keeps rollups off the hot path and drains them in batches', async () => {
    await resetFixture(pool, 1000);

    const response = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: 'outbox:1',
      actions: [
        { action: 'bet', action_id: '6f671acc-6487-4372-9556-779286851001', amount: 100 },
        { action: 'win', action_id: '6f671acc-6487-4372-9556-779286851002', amount: 250 }
      ]
    });
    expect(response.statusCode).toBe(200);

    const beforeRollup = await pool.query('SELECT count(*)::int AS count FROM rtp_user_minute');
    expect(beforeRollup.rows[0].count).toBe(0);

    const pending = await pool.query(
      "SELECT count(*)::int AS count FROM rtp_outbox WHERE status = 'pending'"
    );
    expect(pending.rows[0].count).toBe(2);

    expect(await drainRtpOutbox(pool, 100)).toBe(2);

    const afterRollup = await pool.query(
      `
        SELECT total_bet, total_win, rounds
        FROM rtp_user_minute
        WHERE user_id = $1 AND currency = $2
      `,
      [userId, currency]
    );
    expect(afterRollup.rows[0]).toEqual({ total_bet: 100, total_win: 250, rounds: 1 });
  });
});

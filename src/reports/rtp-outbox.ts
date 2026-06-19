import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../db/transaction.js';

export type RtpOutboxDelta = {
  bucketAt: Date;
  userId: string;
  currency: string;
  totalBet?: number;
  totalWin?: number;
  rounds?: number;
  rollbackCount?: number;
  rolledBackBet?: number;
  rolledBackWin?: number;
};

export async function enqueueRtpDelta(client: PoolClient, delta: RtpOutboxDelta): Promise<void> {
  await client.query(
    `
      INSERT INTO rtp_outbox (
        bucket_minute, user_id, currency, total_bet_delta, total_win_delta, rounds_delta,
        rollback_count_delta, rolled_back_bet_delta, rolled_back_win_delta
      )
      VALUES (
        date_trunc('minute', $1::timestamptz), $2, $3, $4, $5, $6, $7, $8, $9
      )
    `,
    [
      delta.bucketAt.toISOString(),
      delta.userId,
      delta.currency,
      delta.totalBet ?? 0,
      delta.totalWin ?? 0,
      delta.rounds ?? 0,
      delta.rollbackCount ?? 0,
      delta.rolledBackBet ?? 0,
      delta.rolledBackWin ?? 0
    ]
  );
}

export async function recoverStaleRtpOutbox(pool: Pool, staleAfterMs: number): Promise<number> {
  const result = await pool.query(
    `
      UPDATE rtp_outbox
      SET status = 'pending',
          locked_at = NULL
      WHERE status = 'processing'
        AND locked_at < now() - ($1::text || ' milliseconds')::interval
    `,
    [staleAfterMs]
  );
  return result.rowCount ?? 0;
}

export async function drainRtpOutbox(pool: Pool, batchSize = 5000): Promise<number> {
  return inTransaction(pool, async (client) => {
    const claimed = await client.query<{ id: number }>(
      `
        WITH claimed AS (
          SELECT id
          FROM rtp_outbox
          WHERE status = 'pending'
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE rtp_outbox outbox
        SET status = 'processing',
            attempts = attempts + 1,
            locked_at = now()
        FROM claimed
        WHERE outbox.id = claimed.id
        RETURNING outbox.id
      `,
      [batchSize]
    );

    const ids = claimed.rows.map((row) => row.id);
    if (ids.length === 0) return 0;

    await client.query(
      `
        WITH aggregated AS (
          SELECT
            bucket_minute,
            user_id,
            currency,
            sum(total_bet_delta)::bigint AS total_bet,
            sum(total_win_delta)::bigint AS total_win,
            sum(rounds_delta)::bigint AS rounds,
            sum(rollback_count_delta)::bigint AS rollback_count,
            sum(rolled_back_bet_delta)::bigint AS rolled_back_bet,
            sum(rolled_back_win_delta)::bigint AS rolled_back_win
          FROM rtp_outbox
          WHERE id = ANY($1::bigint[])
          GROUP BY bucket_minute, user_id, currency
        )
        INSERT INTO rtp_user_minute (
          bucket_minute, user_id, currency, total_bet, total_win, rounds,
          rollback_count, rolled_back_bet, rolled_back_win
        )
        SELECT
          bucket_minute, user_id, currency, total_bet, total_win, rounds,
          rollback_count, rolled_back_bet, rolled_back_win
        FROM aggregated
        ON CONFLICT (bucket_minute, user_id, currency) DO UPDATE SET
          total_bet = rtp_user_minute.total_bet + EXCLUDED.total_bet,
          total_win = rtp_user_minute.total_win + EXCLUDED.total_win,
          rounds = rtp_user_minute.rounds + EXCLUDED.rounds,
          rollback_count = rtp_user_minute.rollback_count + EXCLUDED.rollback_count,
          rolled_back_bet = rtp_user_minute.rolled_back_bet + EXCLUDED.rolled_back_bet,
          rolled_back_win = rtp_user_minute.rolled_back_win + EXCLUDED.rolled_back_win
      `,
      [ids]
    );

    await client.query(
      `
        UPDATE rtp_outbox
        SET status = 'processed',
            processed_at = now()
        WHERE id = ANY($1::bigint[])
      `,
      [ids]
    );

    return ids.length;
  });
}

export async function drainRtpOutboxUntilEmpty(pool: Pool, batchSize = 5000): Promise<number> {
  let total = 0;
  while (true) {
    const drained = await drainRtpOutbox(pool, batchSize);
    total += drained;
    if (drained === 0) return total;
  }
}

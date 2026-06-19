import type { Pool } from 'pg';
import type { ReportQuery } from '../validation.js';

export type UserRtpRow = {
  user_id: string;
  currency: string;
  rounds: number;
  total_bet: number;
  total_win: number;
  rollback_count: number;
  rolled_back_bet: number;
  rolled_back_win: number;
  rtp: number | null;
};

export async function getUserRtpReport(
  pool: Pool,
  query: ReportQuery
): Promise<{ items: UserRtpRow[]; limit: number; offset: number }> {
  const params: unknown[] = [query.from, query.to, query.limit, query.offset];
  const filters = ['bucket_minute >= $1::timestamptz', 'bucket_minute < $2::timestamptz'];

  if (query.currency) {
    params.push(query.currency);
    filters.push(`currency = $${params.length}`);
  }
  if (query.user_id) {
    params.push(query.user_id);
    filters.push(`user_id = $${params.length}`);
  }

  const result = await pool.query<UserRtpRow>(
    `
      SELECT
        user_id,
        currency,
        sum(rounds)::bigint AS rounds,
        sum(total_bet)::bigint AS total_bet,
        sum(total_win)::bigint AS total_win,
        sum(rollback_count)::bigint AS rollback_count,
        sum(rolled_back_bet)::bigint AS rolled_back_bet,
        sum(rolled_back_win)::bigint AS rolled_back_win,
        CASE
          WHEN sum(total_bet) = 0 THEN NULL
          ELSE (sum(total_win)::numeric / sum(total_bet)::numeric)::float
        END AS rtp
      FROM rtp_user_minute
      WHERE ${filters.join(' AND ')}
      GROUP BY user_id, currency
      ORDER BY user_id, currency
      LIMIT $3 OFFSET $4
    `,
    params
  );

  return { items: result.rows, limit: query.limit, offset: query.offset };
}

export async function getCasinoRtpReport(pool: Pool, query: ReportQuery): Promise<UserRtpRow> {
  const params: unknown[] = [query.from, query.to, query.currency ?? 'ALL'];
  const filters = ['bucket_minute >= $1::timestamptz', 'bucket_minute < $2::timestamptz'];
  if (query.currency) filters.push('currency = $3');

  const result = await pool.query<UserRtpRow>(
    `
      SELECT
        'ALL'::text AS user_id,
        $3::text AS currency,
        coalesce(sum(rounds), 0)::bigint AS rounds,
        coalesce(sum(total_bet), 0)::bigint AS total_bet,
        coalesce(sum(total_win), 0)::bigint AS total_win,
        coalesce(sum(rollback_count), 0)::bigint AS rollback_count,
        coalesce(sum(rolled_back_bet), 0)::bigint AS rolled_back_bet,
        coalesce(sum(rolled_back_win), 0)::bigint AS rolled_back_win,
        CASE
          WHEN coalesce(sum(total_bet), 0) = 0 THEN NULL
          ELSE (sum(total_win)::numeric / sum(total_bet)::numeric)::float
        END AS rtp
      FROM rtp_user_minute
      WHERE ${filters.join(' AND ')}
    `,
    params
  );

  return result.rows[0];
}

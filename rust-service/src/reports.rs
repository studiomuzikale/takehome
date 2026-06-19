use sqlx::PgPool;

use crate::{
    error::AppError,
    models::{ReportQuery, RtpRow, UserRtpResponse},
};

pub async fn user_rtp(pool: &PgPool, query: ReportQuery) -> Result<UserRtpResponse, AppError> {
    let limit = query.limit.clamp(1, 500);
    let offset = query.offset.max(0);
    let rows = sqlx::query_as::<_, RtpRow>(
        r#"
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
        WHERE bucket_minute >= $1
          AND bucket_minute < $2
          AND ($3::text IS NULL OR currency = $3)
          AND ($4::text IS NULL OR user_id = $4)
        GROUP BY user_id, currency
        ORDER BY user_id, currency
        LIMIT $5 OFFSET $6
        "#,
    )
    .bind(query.from)
    .bind(query.to)
    .bind(query.currency)
    .bind(query.user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(UserRtpResponse {
        items: rows,
        limit,
        offset,
    })
}

pub async fn casino_rtp(pool: &PgPool, query: ReportQuery) -> Result<RtpRow, AppError> {
    let row = sqlx::query_as::<_, RtpRow>(
        r#"
        SELECT
          'ALL'::text AS user_id,
          coalesce($3::text, 'ALL') AS currency,
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
        WHERE bucket_minute >= $1
          AND bucket_minute < $2
          AND ($3::text IS NULL OR currency = $3)
        "#,
    )
    .bind(query.from)
    .bind(query.to)
    .bind(query.currency)
    .fetch_one(pool)
    .await?;

    Ok(row)
}

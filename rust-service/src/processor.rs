use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use crate::{
    error::AppError,
    models::{
        ClaimResult, ClaimedAction, ExistingAction, ProcessAction, ProcessRequest, ProcessResponse,
        TransactionResponse,
    },
};

pub async fn proces_request(
    pool: &PgPool,
    request: ProcessRequest,
) -> Result<ProcessResponse, AppError> {
    let mut tx = pool.begin().await?;
    let mut balance = lock_account(&mut tx, &request.user_id, &request.currency).await?;
    let actions = request.actions.clone().unwrap_or_default();

    if actions.is_empty() {
        tx.commit().await?;
        return Ok(ProcessResponse::BalanceOnly { balance });
    }

    let mut transactions = Vec::with_capacity(actions.len());

    for action in actions {
        let action_id = action.action_id();
        let claim = claim_action(&mut tx, action_id, &request.user_id, &request.currency).await?;
        let claimed = match claim {
            ClaimResult::Duplicate { tx_id } => {
                transactions.push(TransactionResponse { action_id, tx_id });
                continue;
            }
            ClaimResult::Claimed(claimed) => claimed,
        };

        let tx_id = match action {
            ProcessAction::Bet { amount, .. } => {
                let result = process_bet_or_win(
                    &mut tx, &request, action_id, "bet", amount, &claimed, balance,
                )
                .await?;
                balance = result.balance;
                result.tx_id
            }
            ProcessAction::Win { amount, .. } => {
                let result = process_bet_or_win(
                    &mut tx, &request, action_id, "win", amount, &claimed, balance,
                )
                .await?;
                balance = result.balance;
                result.tx_id
            }
            ProcessAction::Rollback {
                original_action_id, ..
            } => {
                let result = process_rollback(
                    &mut tx,
                    &request,
                    action_id,
                    original_action_id,
                    &claimed,
                    balance,
                )
                .await?;
                balance = result.balance;
                result.tx_id
            }
        };

        transactions.push(TransactionResponse { action_id, tx_id });
    }

    sqlx::query(
        r#"
        UPDATE accounts
        SET balance = $3, updated_at = now()
        WHERE user_id = $1 AND currency = $2
        "#,
    )
    .bind(&request.user_id)
    .bind(&request.currency)
    .bind(balance)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(ProcessResponse::Actions {
        game_id: request.game_id,
        transactions,
        balance,
    })
}

struct ProcessedAction {
    balance: i64,
    tx_id: Uuid,
}

async fn lock_account(
    tx: &mut Transaction<'_, Postgres>,
    user_id: &str,
    currency: &str,
) -> Result<i64, AppError> {
    sqlx::query(
        r#"
        INSERT INTO accounts (user_id, currency, balance)
        VALUES ($1, $2, 0)
        ON CONFLICT (user_id, currency) DO NOTHING
        "#,
    )
    .bind(user_id)
    .bind(currency)
    .execute(&mut **tx)
    .await?;

    let row = sqlx::query(
        r#"
        SELECT balance
        FROM accounts
        WHERE user_id = $1 AND currency = $2
        FOR UPDATE
        "#,
    )
    .bind(user_id)
    .bind(currency)
    .fetch_one(&mut **tx)
    .await?;

    Ok(row.get::<i64, _>("balance"))
}

async fn claim_action(
    tx: &mut Transaction<'_, Postgres>,
    action_id: Uuid,
    user_id: &str,
    currency: &str,
) -> Result<ClaimResult, AppError> {
    let ledger_created_at = Utc::now();
    let row = sqlx::query(
        r#"
        WITH input AS (
          SELECT
            $1::uuid AS action_id,
            $2::text AS user_id,
            $3::text AS currency,
            $4::timestamptz AS ledger_created_at,
            hashtext($2 || ':' || $3) AS account_hash
        ),
        inserted AS (
          INSERT INTO action_registry (action_id, user_id, currency, ledger_created_at)
          SELECT action_id, user_id, currency, ledger_created_at
          FROM input
          ON CONFLICT (action_id) DO NOTHING
          RETURNING tx_id, ledger_created_at, true AS claimed
        )
        SELECT inserted.tx_id, inserted.ledger_created_at, input.account_hash, inserted.claimed
        FROM inserted
        CROSS JOIN input
        UNION ALL
        SELECT action_registry.tx_id, action_registry.ledger_created_at, input.account_hash, false AS claimed
        FROM action_registry
        CROSS JOIN input
        WHERE action_registry.action_id = input.action_id
          AND NOT EXISTS (SELECT 1 FROM inserted)
        "#,
    )
    .bind(action_id)
    .bind(user_id)
    .bind(currency)
    .bind(ledger_created_at)
    .fetch_one(&mut **tx)
    .await?;

    let tx_id = row.get::<Uuid, _>("tx_id");
    let claimed = row.get::<bool, _>("claimed");
    if claimed {
        Ok(ClaimResult::Claimed(ClaimedAction {
            tx_id,
            created_at: row.get::<DateTime<Utc>, _>("ledger_created_at"),
            account_hash: row.get::<i32, _>("account_hash"),
        }))
    } else {
        Ok(ClaimResult::Duplicate { tx_id })
    }
}

async fn process_bet_or_win(
    tx: &mut Transaction<'_, Postgres>,
    request: &ProcessRequest,
    action_id: Uuid,
    action_type: &str,
    amount: i64,
    claimed: &ClaimedAction,
    balance: i64,
) -> Result<ProcessedAction, AppError> {
    if amount <= 0 {
        return Err(AppError::BadRequest);
    }

    let intent = sqlx::query(
        "SELECT rollback_action_id FROM rollback_intents WHERE original_action_id = $1",
    )
    .bind(action_id)
    .fetch_optional(&mut **tx)
    .await?;
    let is_noop = intent.is_some();
    let delta = if is_noop {
        0
    } else if action_type == "bet" {
        -amount
    } else {
        amount
    };
    let next_balance = balance + delta;
    if next_balance < 0 {
        return Err(AppError::InsufficientFunds);
    }

    ensure_atcion_partition(tx, claimed.created_at).await?;

    let row = sqlx::query(
        r#"
        INSERT INTO actions (
          action_id, tx_id, account_hash, user_id, currency, game, game_id,
          action_type, amount, balance_delta, status, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING created_at
        "#,
    )
    .bind(action_id)
    .bind(claimed.tx_id)
    .bind(claimed.account_hash)
    .bind(&request.user_id)
    .bind(&request.currency)
    .bind(&request.game)
    .bind(&request.game_id)
    .bind(action_type)
    .bind(amount)
    .bind(delta)
    .bind(if is_noop { "noop_prerolled" } else { "applied" })
    .bind(claimed.created_at)
    .fetch_one(&mut **tx)
    .await?;

    let created_at = row.get::<DateTime<Utc>, _>("created_at");
    if is_noop {
        add_rolled_back_original_to_rollup(
            tx,
            created_at,
            &request.user_id,
            &request.currency,
            action_type,
            amount,
        )
        .await?;
    } else {
        add_applied_original_to_rollup(
            tx,
            created_at,
            &request.user_id,
            &request.currency,
            action_type,
            amount,
        )
        .await?;
    }

    Ok(ProcessedAction {
        balance: next_balance,
        tx_id: claimed.tx_id,
    })
}

async fn process_rollback(
    tx: &mut Transaction<'_, Postgres>,
    request: &ProcessRequest,
    action_id: Uuid,
    original_action_id: Uuid,
    claimed: &ClaimedAction,
    balance: i64,
) -> Result<ProcessedAction, AppError> {
    let existing_intent = sqlx::query(
        "SELECT rollback_action_id FROM rollback_intents WHERE original_action_id = $1",
    )
    .bind(original_action_id)
    .fetch_optional(&mut **tx)
    .await?;

    if existing_intent.is_some() {
        let inserted = insert_rollback_action(
            tx,
            request,
            action_id,
            original_action_id,
            claimed,
            0,
            "noop_already_rolled_back",
        )
        .await?;
        return Ok(ProcessedAction {
            balance,
            tx_id: inserted.tx_id,
        });
    }

    let original = find_action_for_update(tx, original_action_id).await?;
    let Some(original) = original else {
        let inserted = insert_rollback_action(
            tx,
            request,
            action_id,
            original_action_id,
            claimed,
            0,
            "noop_tombstone",
        )
        .await?;
        insert_rollback_intent(
            tx,
            original_action_id,
            action_id,
            &request.user_id,
            &request.currency,
        )
        .await?;
        add_rollback_count_to_rollup(tx, inserted.created_at, &request.user_id, &request.currency)
            .await?;
        return Ok(ProcessedAction {
            balance,
            tx_id: inserted.tx_id,
        });
    };

    if original.status != "applied" || original.balance_delta == 0 {
        let inserted = insert_rollback_action(
            tx,
            request,
            action_id,
            original_action_id,
            claimed,
            0,
            "noop_original_not_applied",
        )
        .await?;
        insert_rollback_intent(
            tx,
            original_action_id,
            action_id,
            &request.user_id,
            &request.currency,
        )
        .await?;
        add_rollback_count_to_rollup(tx, inserted.created_at, &request.user_id, &request.currency)
            .await?;
        return Ok(ProcessedAction {
            balance,
            tx_id: inserted.tx_id,
        });
    }

    let rollback_delta = -original.balance_delta;
    let next_balance = balance + rollback_delta;
    if next_balance < 0 {
        return Err(AppError::InsufficientFunds);
    }

    let inserted = insert_rollback_action(
        tx,
        request,
        action_id,
        original_action_id,
        claimed,
        rollback_delta,
        "applied",
    )
    .await?;
    insert_rollback_intent(
        tx,
        original_action_id,
        action_id,
        &request.user_id,
        &request.currency,
    )
    .await?;

    sqlx::query(
        r#"
        UPDATE actions
        SET rolled_back_by = $2, rolled_back_at = now()
        WHERE action_id = $1 AND created_at = $3
        "#,
    )
    .bind(original.action_id)
    .bind(action_id)
    .bind(original.created_at)
    .execute(&mut **tx)
    .await?;

    remove_applied_original_from_rollup(
        tx,
        original.created_at,
        &original.user_id,
        &original.currency,
        &original.action_type,
        original.amount.unwrap_or(0),
    )
    .await?;
    add_rollback_count_to_rollup(tx, inserted.created_at, &request.user_id, &request.currency)
        .await?;

    Ok(ProcessedAction {
        balance: next_balance,
        tx_id: inserted.tx_id,
    })
}

async fn find_action_for_update(
    tx: &mut Transaction<'_, Postgres>,
    action_id: Uuid,
) -> Result<Option<ExistingAction>, AppError> {
    let row = sqlx::query_as::<_, ExistingAction>(
        r#"
        WITH registry AS (
          SELECT ledger_created_at
          FROM action_registry
          WHERE action_id = $1
        )
        SELECT action_id, user_id, currency, action_type, amount, balance_delta, status, created_at
        FROM actions
        WHERE action_id = $1
          AND created_at = (SELECT ledger_created_at FROM registry)
        FOR UPDATE
        "#,
    )
    .bind(action_id)
    .fetch_optional(&mut **tx)
    .await?;

    Ok(row)
}

struct InsertedRollback {
    tx_id: Uuid,
    created_at: DateTime<Utc>,
}

async fn insert_rollback_action(
    tx: &mut Transaction<'_, Postgres>,
    request: &ProcessRequest,
    action_id: Uuid,
    original_action_id: Uuid,
    claimed: &ClaimedAction,
    delta: i64,
    status: &str,
) -> Result<InsertedRollback, AppError> {
    ensure_atcion_partition(tx, claimed.created_at).await?;
    let row = sqlx::query(
        r#"
        INSERT INTO actions (
          action_id, tx_id, account_hash, user_id, currency, game, game_id,
          action_type, original_action_id, balance_delta, status, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'rollback', $8, $9, $10, $11)
        RETURNING created_at
        "#,
    )
    .bind(action_id)
    .bind(claimed.tx_id)
    .bind(claimed.account_hash)
    .bind(&request.user_id)
    .bind(&request.currency)
    .bind(&request.game)
    .bind(&request.game_id)
    .bind(original_action_id)
    .bind(delta)
    .bind(status)
    .bind(claimed.created_at)
    .fetch_one(&mut **tx)
    .await?;

    Ok(InsertedRollback {
        tx_id: claimed.tx_id,
        created_at: row.get("created_at"),
    })
}

async fn insert_rollback_intent(
    tx: &mut Transaction<'_, Postgres>,
    original_action_id: Uuid,
    rollback_action_id: Uuid,
    user_id: &str,
    currency: &str,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO rollback_intents (original_action_id, rollback_action_id, user_id, currency)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(original_action_id)
    .bind(rollback_action_id)
    .bind(user_id)
    .bind(currency)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn ensure_atcion_partition(
    tx: &mut Transaction<'_, Postgres>,
    created_at: DateTime<Utc>,
) -> Result<(), AppError> {
    sqlx::query("SELECT ensure_actions_month_partition($1::timestamptz)")
        .bind(created_at)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn add_applied_original_to_rollup(
    tx: &mut Transaction<'_, Postgres>,
    created_at: DateTime<Utc>,
    user_id: &str,
    currency: &str,
    action_type: &str,
    amount: i64,
) -> Result<(), AppError> {
    enqueue_rtp_delta(
        tx,
        created_at,
        user_id,
        currency,
        if action_type == "bet" { amount } else { 0 },
        if action_type == "win" { amount } else { 0 },
        if action_type == "bet" { 1 } else { 0 },
        0,
        0,
        0,
    )
    .await
}

async fn remove_applied_original_from_rollup(
    tx: &mut Transaction<'_, Postgres>,
    created_at: DateTime<Utc>,
    user_id: &str,
    currency: &str,
    action_type: &str,
    amount: i64,
) -> Result<(), AppError> {
    if action_type == "rollback" {
        return Ok(());
    }
    enqueue_rtp_delta(
        tx,
        created_at,
        user_id,
        currency,
        if action_type == "bet" { -amount } else { 0 },
        if action_type == "win" { -amount } else { 0 },
        if action_type == "bet" { -1 } else { 0 },
        0,
        if action_type == "bet" { amount } else { 0 },
        if action_type == "win" { amount } else { 0 },
    )
    .await
}

async fn add_rolled_back_original_to_rollup(
    tx: &mut Transaction<'_, Postgres>,
    created_at: DateTime<Utc>,
    user_id: &str,
    currency: &str,
    action_type: &str,
    amount: i64,
) -> Result<(), AppError> {
    enqueue_rtp_delta(
        tx,
        created_at,
        user_id,
        currency,
        0,
        0,
        0,
        0,
        if action_type == "bet" { amount } else { 0 },
        if action_type == "win" { amount } else { 0 },
    )
    .await
}

async fn add_rollback_count_to_rollup(
    tx: &mut Transaction<'_, Postgres>,
    created_at: DateTime<Utc>,
    user_id: &str,
    currency: &str,
) -> Result<(), AppError> {
    enqueue_rtp_delta(tx, created_at, user_id, currency, 0, 0, 0, 1, 0, 0).await
}

#[allow(clippy::too_many_arguments)]
async fn enqueue_rtp_delta(
    tx: &mut Transaction<'_, Postgres>,
    created_at: DateTime<Utc>,
    user_id: &str,
    currency: &str,
    total_bet: i64,
    total_win: i64,
    rounds: i64,
    rollback_count: i64,
    rolled_back_bet: i64,
    rolled_back_win: i64,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO rtp_outbox (
          bucket_minute, user_id, currency, total_bet_delta, total_win_delta, rounds_delta,
          rollback_count_delta, rolled_back_bet_delta, rolled_back_win_delta
        )
        VALUES (date_trunc('minute', $1::timestamptz), $2, $3, $4, $5, $6, $7, $8, $9)
        "#,
    )
    .bind(created_at)
    .bind(user_id)
    .bind(currency)
    .bind(total_bet)
    .bind(total_win)
    .bind(rounds)
    .bind(rollback_count)
    .bind(rolled_back_bet)
    .bind(rolled_back_win)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

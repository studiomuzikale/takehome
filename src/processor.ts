import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './db/transaction.js';
import { insufficientFundsError } from './domain.js';
import { enqueueRtpDelta } from './reports/rtp-outbox.js';
import type { ProcessAction, ProcessRequest } from './validation.js';

export type ProcessResponse =
  | { balance: number }
  | { game_id?: string; transactions: Array<{ action_id: string; tx_id: string }>; balance: number };

type ExistingAction = {
  action_id: string;
  tx_id: string;
  user_id: string;
  currency: string;
  action_type: 'bet' | 'win' | 'rollback';
  amount: number | null;
  balance_delta: number;
  status: string;
  created_at: Date;
};

type ClaimedAction = {
  actionId: string;
  txId: string;
  createdAt: Date;
  accountHash: number;
};

export async function processAggregatorRequest(pool: Pool, request: ProcessRequest): Promise<ProcessResponse> {
  return inTransaction(pool, async (client) => {
    let balance = await lockAccount(client, request.user_id, request.currency);
    const actions = request.actions ?? [];

    if (actions.length === 0) return { balance };

    const transactions: Array<{ action_id: string; tx_id: string }> = [];

    for (const action of actions) {
      const claimed = await claimAtcion(client, action.action_id, request.user_id, request.currency);
      if (!claimed.claimed) {
        transactions.push({ action_id: action.action_id, tx_id: claimed.txId });
        continue;
      }

      if (action.action === 'bet' || action.action === 'win') {
        const result = await processBetOrWin(client, request, action, claimed, balance);
        balance = result.balance;
        transactions.push({ action_id: action.action_id, tx_id: result.txId });
        continue;
      }

      const result = await processRolback(client, request, action, claimed, balance);
      balance = result.balance;
      transactions.push({ action_id: action.action_id, tx_id: result.txId });
    }

    await client.query(
      `
        UPDATE accounts
        SET balance = $3, updated_at = now()
        WHERE user_id = $1 AND currency = $2
      `,
      [request.user_id, request.currency, balance]
    );

    return { game_id: request.game_id, transactions, balance };
  });
}

async function lockAccount(client: PoolClient, userId: string, currency: string): Promise<number> {
  await client.query(
    `
      INSERT INTO accounts (user_id, currency, balance)
      VALUES ($1, $2, 0)
      ON CONFLICT (user_id, currency) DO NOTHING
    `,
    [userId, currency]
  );

  const result = await client.query<{ balance: number }>(
    `
      SELECT balance
      FROM accounts
      WHERE user_id = $1 AND currency = $2
      FOR UPDATE
    `,
    [userId, currency]
  );

  return result.rows[0].balance;
}

async function claimAtcion(
  client: PoolClient,
  actionId: string,
  userId: string,
  currency: string
): Promise<(ClaimedAction & { claimed: true }) | { claimed: false; txId: string }> {
  const ledgerCreatedAt = new Date();
  const result = await client.query<{ tx_id: string; ledger_created_at: Date; account_hash: number; claimed: boolean }>(
    `
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
    `,
    [actionId, userId, currency, ledgerCreatedAt.toISOString()]
  );

  const row = result.rows[0];
  if (row.claimed) {
    return {
      claimed: true,
      actionId,
      txId: row.tx_id,
      createdAt: row.ledger_created_at,
      accountHash: row.account_hash
    };
  }

  return { claimed: false, txId: row.tx_id };
}

async function processBetOrWin(
  client: PoolClient,
  request: ProcessRequest,
  action: Extract<ProcessAction, { action: 'bet' | 'win' }>,
  claimed: ClaimedAction,
  balance: number
): Promise<{ balance: number; txId: string }> {
  const hasPreRollback = await client.query(
    `
      SELECT rollback_action_id
      FROM rollback_intents
      WHERE original_action_id = $1
    `,
    [action.action_id]
  );

  const isNoop = (hasPreRollback.rowCount ?? 0) > 0;
  const delta = isNoop ? 0 : action.action === 'bet' ? -action.amount : action.amount;
  const nextBalance = balance + delta;
  if (nextBalance < 0) throw insufficientFundsError();

  await ensureActionPartition(client, claimed.createdAt);

  const inserted = await client.query<{ created_at: Date }>(
    `
      INSERT INTO actions (
        action_id, tx_id, account_hash, user_id, currency, game, game_id,
        action_type, amount, balance_delta, status, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING created_at
    `,
    [
      action.action_id,
      claimed.txId,
      claimed.accountHash,
      request.user_id,
      request.currency,
      request.game,
      request.game_id ?? null,
      action.action,
      action.amount,
      delta,
      isNoop ? 'noop_prerolled' : 'applied',
      claimed.createdAt.toISOString()
    ]
  );

  const createdAt = inserted.rows[0].created_at;
  if (isNoop) {
    await enqueueRolledBackOriginal(client, createdAt, request.user_id, request.currency, action.action, action.amount);
  } else {
    await enqueueAppliedOriginal(client, createdAt, request.user_id, request.currency, action.action, action.amount);
  }

  return { balance: nextBalance, txId: claimed.txId };
}

async function processRolback(
  client: PoolClient,
  request: ProcessRequest,
  action: Extract<ProcessAction, { action: 'rollback' }>,
  claimed: ClaimedAction,
  balance: number
): Promise<{ balance: number; txId: string }> {
  const existingIntent = await client.query(
    `
      SELECT rollback_action_id
      FROM rollback_intents
      WHERE original_action_id = $1
    `,
    [action.original_action_id]
  );

  if ((existingIntent.rowCount ?? 0) > 0) {
    const inserted = await insertRolbackAction(client, request, action, claimed, 0, 'noop_already_rolled_back');
    return { balance, txId: inserted.txId };
  }

  const original = await findActionForUpdate(client, action.original_action_id);

  if (!original) {
    const inserted = await insertRolbackAction(client, request, action, claimed, 0, 'noop_tombstone');
    await insertRollbackIntent(client, action.original_action_id, action.action_id, request.user_id, request.currency);
    await enqueueRollbackCount(client, inserted.createdAt, request.user_id, request.currency);
    return { balance, txId: inserted.txId };
  }

  if (original.status !== 'applied' || original.balance_delta === 0) {
    const inserted = await insertRolbackAction(client, request, action, claimed, 0, 'noop_original_not_applied');
    await insertRollbackIntent(client, action.original_action_id, action.action_id, request.user_id, request.currency);
    await enqueueRollbackCount(client, inserted.createdAt, request.user_id, request.currency);
    return { balance, txId: inserted.txId };
  }

  const rollbackDelta = -original.balance_delta;
  const nextBalance = balance + rollbackDelta;
  if (nextBalance < 0) throw insufficientFundsError();

  const inserted = await insertRolbackAction(client, request, action, claimed, rollbackDelta, 'applied');
  await insertRollbackIntent(client, action.original_action_id, action.action_id, request.user_id, request.currency);
  await client.query(
    `
      UPDATE actions
      SET rolled_back_by = $2, rolled_back_at = now()
      WHERE action_id = $1
        AND created_at = $3
    `,
    [original.action_id, action.action_id, original.created_at.toISOString()]
  );

  await enqueueRemoveAppliedOriginal(
    client,
    original.created_at,
    original.user_id,
    original.currency,
    original.action_type,
    original.amount ?? 0
  );
  await enqueueRollbackCount(client, inserted.createdAt, request.user_id, request.currency);

  return { balance: nextBalance, txId: inserted.txId };
}

async function findActionForUpdate(client: PoolClient, actionId: string): Promise<ExistingAction | null> {
  const result = await client.query<ExistingAction>(
    `
      WITH registry AS (
        SELECT ledger_created_at
        FROM action_registry
        WHERE action_id = $1
      )
      SELECT action_id, tx_id, user_id, currency, action_type, amount, balance_delta, status, created_at
      FROM actions
      WHERE action_id = $1
        AND created_at = (SELECT ledger_created_at FROM registry)
      FOR UPDATE
    `,
    [actionId]
  );
  return result.rows[0] ?? null;
}

async function insertRolbackAction(
  client: PoolClient,
  request: ProcessRequest,
  action: Extract<ProcessAction, { action: 'rollback' }>,
  claimed: ClaimedAction,
  delta: number,
  status: 'applied' | 'noop_tombstone' | 'noop_already_rolled_back' | 'noop_original_not_applied'
): Promise<{ txId: string; createdAt: Date }> {
  await ensureActionPartition(client, claimed.createdAt);

  const inserted = await client.query<{ created_at: Date }>(
    `
      INSERT INTO actions (
        action_id, tx_id, account_hash, user_id, currency, game, game_id,
        action_type, original_action_id, balance_delta, status, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'rollback', $8, $9, $10, $11)
      RETURNING created_at
    `,
    [
      action.action_id,
      claimed.txId,
      claimed.accountHash,
      request.user_id,
      request.currency,
      request.game,
      request.game_id ?? null,
      action.original_action_id,
      delta,
      status,
      claimed.createdAt.toISOString()
    ]
  );

  return { txId: claimed.txId, createdAt: inserted.rows[0].created_at };
}

async function ensureActionPartition(client: PoolClient, createdAt: Date): Promise<void> {
  await client.query('SELECT ensure_actions_month_partition($1::timestamptz)', [createdAt.toISOString()]);
}

async function insertRollbackIntent(
  client: PoolClient,
  originalActionId: string,
  rollbackActionId: string,
  userId: string,
  currency: string
): Promise<void> {
  await client.query(
    `
      INSERT INTO rollback_intents (original_action_id, rollback_action_id, user_id, currency)
      VALUES ($1, $2, $3, $4)
    `,
    [originalActionId, rollbackActionId, userId, currency]
  );
}

async function enqueueAppliedOriginal(
  client: PoolClient,
  createdAt: Date,
  userId: string,
  currency: string,
  actionType: 'bet' | 'win',
  amount: number
): Promise<void> {
  await enqueueRtpDelta(client, {
    bucketAt: createdAt,
    userId,
    currency,
    totalBet: actionType === 'bet' ? amount : 0,
    totalWin: actionType === 'win' ? amount : 0,
    rounds: actionType === 'bet' ? 1 : 0
  });
}

async function enqueueRemoveAppliedOriginal(
  client: PoolClient,
  createdAt: Date,
  userId: string,
  currency: string,
  actionType: 'bet' | 'win' | 'rollback',
  amount: number
): Promise<void> {
  if (actionType === 'rollback') return;
  await enqueueRtpDelta(client, {
    bucketAt: createdAt,
    userId,
    currency,
    totalBet: actionType === 'bet' ? -amount : 0,
    totalWin: actionType === 'win' ? -amount : 0,
    rounds: actionType === 'bet' ? -1 : 0,
    rolledBackBet: actionType === 'bet' ? amount : 0,
    rolledBackWin: actionType === 'win' ? amount : 0
  });
}

async function enqueueRolledBackOriginal(
  client: PoolClient,
  createdAt: Date,
  userId: string,
  currency: string,
  actionType: 'bet' | 'win',
  amount: number
): Promise<void> {
  await enqueueRtpDelta(client, {
    bucketAt: createdAt,
    userId,
    currency,
    rolledBackBet: actionType === 'bet' ? amount : 0,
    rolledBackWin: actionType === 'win' ? amount : 0
  });
}

async function enqueueRollbackCount(
  client: PoolClient,
  createdAt: Date,
  userId: string,
  currency: string
): Promise<void> {
  await enqueueRtpDelta(client, {
    bucketAt: createdAt,
    userId,
    currency,
    rollbackCount: 1
  });
}

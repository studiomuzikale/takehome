import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { expect } from 'vitest';
import { signBody } from '../src/auth/hmac.js';

export const userId = '8|USDT|USD';
export const currency = 'USD';
export const game = 'acceptance:test';
export const secret = 'test';

export async function resetFixture(pool: Pool, balance: number, user = userId): Promise<void> {
  await pool.query('TRUNCATE rtp_user_minute, rtp_outbox, rollback_intents, actions, action_registry, accounts CASCADE');
  await pool.query(
    'INSERT INTO accounts (user_id, currency, balance) VALUES ($1, $2, $3)',
    [user, currency, balance]
  );
}

export async function signedPost(app: FastifyInstance, body: unknown, signed = true) {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/aggregator/takehome/process',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      ...(signed ? { authorization: `HMAC-SHA256 ${signBody(raw, secret)}` } : {})
    }
  });
}

export async function signedGet(app: FastifyInstance, url: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: {
      authorization: `HMAC-SHA256 ${signBody(Buffer.alloc(0), secret)}`
    }
  });
}

export function expectTxShape(transaction: unknown, actionId: string): string {
  if (!transaction || typeof transaction !== 'object') throw new Error('transaction is not an object');
  const tx = transaction as { action_id?: string; tx_id?: string };
  expect(tx.action_id).toBe(actionId);
  expect(tx.tx_id).toMatch(/^[0-9a-f-]{36}$/);
  if (!tx.tx_id) throw new Error('transaction missing tx_id');
  return tx.tx_id;
}

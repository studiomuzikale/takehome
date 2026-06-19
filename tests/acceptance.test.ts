import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/http/app.js';
import { currency, expectTxShape, game, resetFixture, secret, signedPost, userId } from './helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://yeet:yeet@localhost:5432/yeet';
const pool = createPool(databaseUrl);
const app = buildApp(pool, secret, 'silent');

describe('acceptance scenarios A-J', () => {
  beforeAll(async () => {
    await migrate(databaseUrl);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('A. Missing Authorization -> 403', async () => {
    const response = await signedPost(app, { user_id: userId, currency }, false);
    expect(response.statusCode).toBe(403);
  });

  it('B. Balance lookup', async () => {
    await resetFixture(pool, 74322001);
    const response = await signedPost(app, { user_id: userId, currency, game });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ balance: 74322001 });
  });

  it('C. Single bet, finished, no win', async () => {
    await resetFixture(pool, 74322001);
    const actionId = '3b42f070-dab5-4d6c-8bc6-7241b68f00bd';
    const response = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: '1761032910245540510',
      finished: true,
      actions: [{ action: 'bet', action_id: actionId, amount: 100 }]
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.game_id).toBe('1761032910245540510');
    expect(body.balance).toBe(74321901);
    expectTxShape(body.transactions[0], actionId);
  });

  it('D. Bet + win in the same call', async () => {
    await resetFixture(pool, 74321901);
    const betId = '7c8affbf-53fd-4fcc-b1ca-18118c5dd287';
    const winId = '86441c7a-560e-4501-b829-110af6a1b956';
    const response = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: '1761032910488163506',
      actions: [
        { action: 'bet', action_id: betId, amount: 100 },
        { action: 'win', action_id: winId, amount: 250 }
      ]
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ game_id: '1761032910488163506', balance: 74322051 });
    expectTxShape(body.transactions[0], betId);
    expectTxShape(body.transactions[1], winId);
  });

  it('E. Insufficient funds rejects the whole request', async () => {
    await resetFixture(pool, 74322051);
    const response = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: '1761032911004723918',
      finished: true,
      actions: [{ action: 'bet', action_id: '6c1e98e8-8e93-4856-b6ef-8b2ddc6c4cbc', amount: 74322202 }]
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.json()).toEqual({
      code: 100,
      message: 'Player has not enough funds to process an action'
    });

    const lookup = await signedPost(app, { user_id: userId, currency, game });
    expect(lookup.json()).toEqual({ balance: 74322051 });
  });

  it('F. Bet then win in separate calls', async () => {
    await resetFixture(pool, 74322201);
    const betId = '19bd35d5-50c3-4720-a402-145a46ab874c';
    const winId = 'dcafc246-24b6-458b-a823-f6e7ecd6e9c3';

    const bet = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: '1761032911166149146',
      actions: [{ action: 'bet', action_id: betId, amount: 100 }]
    });
    expect(bet.statusCode).toBe(200);
    expect(bet.json().balance).toBe(74322101);
    expectTxShape(bet.json().transactions[0], betId);

    const win = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: '1761032911166149146',
      finished: true,
      actions: [{ action: 'win', action_id: winId, amount: 700 }]
    });
    expect(win.statusCode).toBe(200);
    expect(win.json().balance).toBe(74322801);
    expectTxShape(win.json().transactions[0], winId);
  });

  it('G. Bet then rollback that bet', async () => {
    await resetFixture(pool, 74322001);
    const betId = '4dbcbf1d-bcf6-43e9-9a62-7d3c0f3c6486';
    const rollbackId = 'c9a9c3a7-e9e8-4f5a-9fdf-1d8a377d1b8f';

    const bet = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: '1761034000123456789',
      actions: [{ action: 'bet', action_id: betId, amount: 100 }]
    });
    expect(bet.json().balance).toBe(74321901);

    const rollback = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: '1761034000123456789',
      finished: true,
      actions: [{ action: 'rollback', action_id: rollbackId, original_action_id: betId }]
    });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json().balance).toBe(74322001);
    expectTxShape(rollback.json().transactions[0], rollbackId);
  });

  it('H. Duplicate bet id replays original tx_id and only new actions apply', async () => {
    await resetFixture(pool, 74322151);
    const duplicateBetId = 'f61c5eba-fb26-4070-89b5-c3a2edf54c02';
    const newBetId = 'd94b2fa5-e87f-4d8e-9a01-4a443ed5c11c';

    const first = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: '1761032913606999220',
      actions: [{ action: 'bet', action_id: duplicateBetId, amount: 100 }]
    });
    expect(first.json().balance).toBe(74322051);
    const firstTx = expectTxShape(first.json().transactions[0], duplicateBetId);

    const second = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: '1761032913606999220',
      actions: [
        { action: 'bet', action_id: duplicateBetId, amount: 100 },
        { action: 'bet', action_id: newBetId, amount: 50 }
      ]
    });
    const body = second.json();
    expect(body.balance).toBe(74322001);
    expect(body.transactions[0]).toEqual({ action_id: duplicateBetId, tx_id: firstTx });
    expectTxShape(body.transactions[1], newBetId);
  });

  it('I. Rollback arrives before the bet', async () => {
    await resetFixture(pool, 74321821);
    const rollbackId = '65d57850-5ee3-418b-b1b0-b4975242efcf';
    const betId = '27710aca-60f9-4259-a9bb-26f75cd05917';

    const rollback = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: '1761032915476894301',
      finished: true,
      actions: [{ action: 'rollback', action_id: rollbackId, original_action_id: betId }]
    });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json().balance).toBe(74321821);
    expectTxShape(rollback.json().transactions[0], rollbackId);

    const lateBet = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: '1761032915476894301',
      finished: true,
      actions: [{ action: 'bet', action_id: betId, amount: 100 }]
    });
    expect(lateBet.statusCode).toBe(200);
    expect(lateBet.json().balance).toBe(74321821);
    expectTxShape(lateBet.json().transactions[0], betId);
  });

  it('J. Rollbacks for bet and win arrive before either exists', async () => {
    await resetFixture(pool, 74321821);
    const betRollbackId = '12af93e7-f208-46f1-9399-4c1668fdd675';
    const winRollbackId = '85762689-2ab3-40d6-a7cd-e3babb53ae06';
    const betId = 'a2fd2ce9-5184-48b6-bdde-f6ba05d32e01';
    const winId = '7e4ad25b-b2c2-4eb7-b38e-63e7ddcdab52';

    const rollbacks = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: '1761032916227566632',
      finished: true,
      actions: [
        { action: 'rollback', action_id: betRollbackId, original_action_id: betId },
        { action: 'rollback', action_id: winRollbackId, original_action_id: winId }
      ]
    });
    expect(rollbacks.statusCode).toBe(200);
    expect(rollbacks.json().balance).toBe(74321821);

    const lateOriginals = await signedPost(app, {
      user_id: userId,
      currency,
      game,
      game_id: '1761032916227566632',
      finished: true,
      actions: [
        { action: 'bet', action_id: betId, amount: 100 },
        { action: 'win', action_id: winId, amount: 200 }
      ]
    });
    expect(lateOriginals.statusCode).toBe(200);
    expect(lateOriginals.json().balance).toBe(74321821);
    expectTxShape(lateOriginals.json().transactions[0], betId);
    expectTxShape(lateOriginals.json().transactions[1], winId);
  });
});

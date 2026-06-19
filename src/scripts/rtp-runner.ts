import { randomUUID } from 'node:crypto';
import { signBody } from '../auth/hmac.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { drainRtpOutboxUntilEmpty } from '../reports/rtp-outbox.js';

const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
const secret = process.env.HMAC_SECRET ?? 'test';
const users = Number(process.env.RUNNER_USERS ?? 1000);
const rounds = Number(process.env.RUNNER_ROUNDS ?? 50_000);
const concurrency = Number(process.env.RUNNER_CONCURRENCY ?? 50);
const currency = process.env.RUNNER_CURRENCY ?? 'USD';
const betAmount = Number(process.env.RUNNER_BET_AMOUNT ?? 100);
const winProbability = Number(process.env.RUNNER_WIN_PROBABILITY ?? 0.2);
const winPayout = Math.round((betAmount * 0.95) / winProbability);
const drainOutboxBeforeReport = process.env.RUNNER_DRAIN_RTP_OUTBOX !== 'false';

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function postJson(path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `HMAC-SHA256 ${signBody(raw, secret)}`
    },
    body: raw
  });

  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function signedGet(path: string) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { authorization: `HMAC-SHA256 ${signBody(Buffer.alloc(0), secret)}` }
  });

  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function main() {
  const startedAt = new Date(Date.now() - 60_000);
  const rng = mulberry32(Number(process.env.RUNNER_SEED ?? 42));
  let totalBet = 0;
  let totalWin = 0;
  let nextRound = 0;

  async function worker() {
    while (true) {
      const round = nextRound;
      nextRound += 1;
      if (round >= rounds) return;

      const won = rng() < winProbability;
      const actions = [
        { action: 'bet' as const, action_id: randomUUID(), amount: betAmount },
        ...(won ? [{ action: 'win' as const, action_id: randomUUID(), amount: winPayout }] : [])
      ];

      totalBet += betAmount;
      if (won) totalWin += winPayout;

      await postJson('/aggregator/takehome/process', {
        user_id: `runner-user-${Math.floor(rng() * users)}`,
        currency,
        game: 'runner:slots',
        game_id: `runner-${round}`,
        finished: true,
        actions
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (drainOutboxBeforeReport) {
    const pool = createPool(loadConfig().databaseUrl);
    try {
      await drainRtpOutboxUntilEmpty(pool);
    } finally {
      await pool.end();
    }
  }

  const from = encodeURIComponent(startedAt.toISOString());
  const to = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
  const report = await signedGet(`/reports/rtp/casino?from=${from}&to=${to}&currency=${currency}`);
  const delta = Math.abs(report.rtp - 0.95);

  console.log(JSON.stringify({
    rounds,
    users,
    totalBet,
    totalWin,
    simulatedRtp: totalWin / totalBet,
    reportedRtp: report.rtp,
    tolerance: 0.05,
    pass: delta <= 0.05
  }, null, 2));

  if (delta > 0.05) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

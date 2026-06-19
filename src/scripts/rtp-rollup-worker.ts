import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { drainRtpOutbox, recoverStaleRtpOutbox } from '../reports/rtp-outbox.js';

const config = loadConfig();
const batchSize = Number(process.env.RTP_OUTBOX_BATCH_SIZE ?? 5000);
const idleSleepMs = Number(process.env.RTP_OUTBOX_IDLE_SLEEP_MS ?? 100);
const staleAfterMs = Number(process.env.RTP_OUTBOX_STALE_AFTER_MS ?? 60_000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await migrate(config.databaseUrl);
  const pool = createPool(config.databaseUrl);
  let stopping = false;

  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });

  console.log(JSON.stringify({
    msg: 'RTP rollup worker started',
    batchSize,
    idleSleepMs,
    staleAfterMs
  }));

  try {
    while (!stopping) {
      await recoverStaleRtpOutbox(pool, staleAfterMs);
      const drained = await drainRtpOutbox(pool, batchSize);
      if (drained === 0) await sleep(idleSleepMs);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

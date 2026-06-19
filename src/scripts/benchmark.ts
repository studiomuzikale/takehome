import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { signBody } from '../auth/hmac.js';

const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
const secret = process.env.HMAC_SECRET ?? 'test';
const clients = Number(process.env.BENCH_CLIENTS ?? 250);
const roundsPerClient = Number(process.env.BENCH_ROUNDS_PER_CLIENT ?? 200);
const users = Number(process.env.BENCH_USERS ?? 1000);
const retries = Number(process.env.BENCH_RETRIES ?? 2);
const requestTimeoutMs = Number(process.env.BENCH_REQUEST_TIMEOUT_MS ?? 15_000);
const maxSockets = Number(process.env.BENCH_HTTP_SOCKETS ?? Math.min(clients, 100));
const totalRequests = clients * roundsPerClient;
const parsedApiUrl = new URL(apiUrl);
const httpAgent = new http.Agent({ keepAlive: true, maxSockets });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets });

async function preflight() {
  const deadline = Date.now() + Number(process.env.BENCH_PREFLIGHT_TIMEOUT_MS ?? 30_000);
  let lastError: unknown;

  try {
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${apiUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) return;
        lastError = new Error(`health check returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await sleep(500);
    }
  } catch (error) {
    lastError = error;
  }

  throw new Error(
    `Cannot reach API at ${apiUrl}. Start it first with "npm run dev" or "docker compose up --build", or set API_URL to the running service URL.`,
    { cause: lastError }
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postRound(clientId: number, round: number): Promise<{ status?: number; latencyMs: number; networkError?: string; attempts: number }> {
  const raw = JSON.stringify({
    user_id: `runner-user-${(clientId + round) % users}`,
    currency: 'USD',
    game: 'benchmark:slots',
    game_id: `bench-${clientId}-${round}-${randomUUID()}`,
    finished: true,
    actions: [
      { action: 'bet', action_id: randomUUID(), amount: 100 },
      ...(Math.random() < 0.2 ? [{ action: 'win', action_id: randomUUID(), amount: 475 }] : [])
    ]
  });

  const started = performance.now();
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const status = await postRaw('/aggregator/takehome/process', raw);
      return { status, latencyMs: performance.now() - started, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(10 * 2 ** attempt);
    }
  }

  const cause = lastError instanceof Error && 'cause' in lastError ? lastError.cause : lastError;
  const networkError = cause instanceof Error ? cause.message : 'fetch failed';
  return { latencyMs: performance.now() - started, networkError, attempts: retries + 1 };
}

async function postRaw(path: string, raw: string): Promise<number> {
  const transport = parsedApiUrl.protocol === 'https:' ? https : http;
  const agent = parsedApiUrl.protocol === 'https:' ? httpsAgent : httpAgent;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: parsedApiUrl.protocol,
        hostname: parsedApiUrl.hostname,
        port: parsedApiUrl.port,
        path,
        method: 'POST',
        agent,
        timeout: requestTimeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(raw),
          authorization: `HMAC-SHA256 ${signBody(raw, secret)}`
        }
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error(`request timeout after ${requestTimeoutMs}ms`));
    });
    request.on('error', reject);
    request.end(raw);
  });
}

async function main() {
  await preflight();

  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  const networkErrors = new Map<string, number>();
  let retryAttempts = 0;
  const started = performance.now();

  async function client(clientId: number) {
    for (let round = 0; round < roundsPerClient; round += 1) {
      const result = await postRound(clientId, round);
      latencies.push(result.latencyMs);
      retryAttempts += result.attempts - 1;
      if (result.status !== undefined) {
        statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
      } else {
        const key = result.networkError ?? 'network error';
        networkErrors.set(key, (networkErrors.get(key) ?? 0) + 1);
      }
    }
  }

  await Promise.all(Array.from({ length: clients }, (_, clientId) => client(clientId)));
  const elapsedSeconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);

  const percentile = (p: number) => latencies[Math.floor((latencies.length - 1) * p)];
  const failures = [...statuses.entries()]
    .filter(([status]) => status < 200 || status >= 300)
    .reduce((sum, [, count]) => sum + count, 0)
    + [...networkErrors.values()].reduce((sum, count) => sum + count, 0);

  console.log(JSON.stringify({
    clients,
    roundsPerClient,
    totalRequests,
    retries,
    retryAttempts,
    maxSockets,
    requestTimeoutMs,
    failures,
    elapsedSeconds,
    throughput: totalRequests / elapsedSeconds,
    statuses: Object.fromEntries([...statuses.entries()].sort(([a], [b]) => a - b)),
    networkErrors: Object.fromEntries([...networkErrors.entries()].sort(([a], [b]) => a.localeCompare(b))),
    latencyMs: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: latencies[latencies.length - 1]
    }
  }, null, 2));

  if (failures > 0) {
    console.error('benchmark completed with failed requests; check API logs, seed balances, or lower BENCH_CLIENTS for this machine');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

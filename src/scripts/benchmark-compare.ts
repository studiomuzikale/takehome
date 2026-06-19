import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';

type BenchmarkOutput = {
  clients: number;
  roundsPerClient: number;
  totalRequests: number;
  retries: number;
  retryAttempts: number;
  maxSockets: number;
  requestTimeoutMs: number;
  failures: number;
  elapsedSeconds: number;
  throughput: number;
  statuses: Record<string, number>;
  networkErrors: Record<string, number>;
  latencyMs: {
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
};

type Target = {
  name: string;
  apiUrl: string;
};

type ComparisonResult = BenchmarkOutput & {
  service: string;
  apiUrl: string;
};

type ComparisonReport = {
  generatedAt: string;
  config: {
    loadLevels: number[];
    roundsPerClient: number;
    users: number;
    retries: number;
    maxSockets: number;
    requestTimeoutMs: number;
    alternateTargetOrder: boolean;
    cleanSeedBeforeEach: boolean;
    cooldownMs: number;
    databaseUrl: string;
    seedBalance: number;
    targets: Target[];
  };
  results: ComparisonResult[];
};

const reportDir = resolve(process.cwd(), process.env.BENCH_REPORT_DIR ?? 'reports');
const loadLevels = parseNumberList(process.env.BENCH_LOAD_LEVELS ?? '50,100,200,300');
const roundsPerClient = Number(process.env.BENCH_ROUNDS_PER_CLIENT ?? process.env.BENCH_MATRIX_ROUNDS_PER_CLIENT ?? 200);
const users = Number(process.env.BENCH_USERS ?? 10_000);
const retries = Number(process.env.BENCH_RETRIES ?? 2);
const maxSockets = Number(process.env.BENCH_HTTP_SOCKETS ?? process.env.BENCH_MATRIX_MAX_SOCKETS ?? 100);
const requestTimeoutMs = Number(process.env.BENCH_REQUEST_TIMEOUT_MS ?? 15_000);
const targets = parseTargets(process.env.BENCH_TARGETS ?? 'typescript=http://localhost:3000,rust=http://localhost:3001');
const alternateTargetOrder = process.env.BENCH_ALTERNATE_TARGET_ORDER !== 'false';
const cleanSeedBeforeEach = process.env.BENCH_CLEAN_SEED_BEFORE_EACH !== 'false';
const cooldownMs = Number(process.env.BENCH_COMPARE_COOLDOWN_MS ?? 1_000);
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://yeet:yeet@localhost:5432/yeet';
const seedBalance = Number(process.env.BENCH_SEED_BALANCE ?? process.env.SEED_BALANCE ?? 1_000_000_000);

function parseNumberList(value: string): number[] {
  const parsed = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((number) => Number.isFinite(number) && number > 0);

  if (parsed.length === 0) {
    throw new Error('BENCH_LOAD_LEVELS must contain at least one positive number');
  }

  return parsed;
}

function parseTargets(value: string): Target[] {
  const parsed = value.split(',').map((entry) => {
    const [name, apiUrl] = entry.split('=');
    if (!name || !apiUrl) {
      throw new Error('BENCH_TARGETS must look like "typescript=http://localhost:3000,rust=http://localhost:3001"');
    }
    return { name: name.trim(), apiUrl: apiUrl.trim() };
  });

  if (parsed.length === 0) {
    throw new Error('BENCH_TARGETS must contain at least one target');
  }

  return parsed;
}

async function runBenchmark(target: Target, clients: number): Promise<BenchmarkOutput> {
  const env = {
    ...process.env,
    API_URL: target.apiUrl,
    BENCH_CLIENTS: String(clients),
    BENCH_ROUNDS_PER_CLIENT: String(roundsPerClient),
    BENCH_USERS: String(users),
    BENCH_RETRIES: String(retries),
    BENCH_HTTP_SOCKETS: String(maxSockets),
    BENCH_REQUEST_TIMEOUT_MS: String(requestTimeoutMs)
  };

  const { stdout, stderr, code } = await runCommand('npm', ['--silent', 'run', 'benchmark'], env);
  const output = parseBenchmarkJson(stdout);

  if (code !== 0 && output.failures === 0) {
    throw new Error(`benchmark failed for ${target.name} at ${clients} clients\n${stderr}`);
  }

  if (stderr.trim().length > 0) {
    process.stderr.write(stderr);
  }

  return output;
}

async function cleanAndSeed(target: Target, clients: number): Promise<void> {
  console.log(`\nResetting database before ${target.name} at ${clients} clients`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: 10_000
  });
  try {
    const schemaSql = await readFile(resolve(process.cwd(), 'sql/schema.sql'), 'utf8');
    await pool.query(schemaSql);
    await pool.query(`
      TRUNCATE TABLE
        rtp_outbox,
        rtp_user_minute,
        rollback_intents,
        actions,
        action_registry,
        accounts
      RESTART IDENTITY CASCADE
    `);
    await seedAccounts(pool);
  } finally {
    await pool.end();
  }
}

async function seedAccounts(pool: Pool): Promise<void> {
  for (let offset = 0; offset < users; offset += 1000) {
    const batchSize = Math.min(1000, users - offset);
    const values: string[] = [];
    const params: Array<string | number> = [];

    for (let i = 0; i < batchSize; i += 1) {
      params.push(`runner-user-${offset + i}`, 'USD', seedBalance);
      const base = i * 3;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    }

    await pool.query(
      `
        INSERT INTO accounts (user_id, currency, balance)
        VALUES ${values.join(', ')}
        ON CONFLICT (user_id, currency) DO UPDATE SET
          balance = EXCLUDED.balance,
          updated_at = now()
      `,
      params
    );
  }

  await pool.query(
    `
      INSERT INTO accounts (user_id, currency, balance)
      VALUES ('8|USDT|USD', 'USD', 74322001)
      ON CONFLICT (user_id, currency) DO UPDATE SET balance = EXCLUDED.balance
    `
  );

  console.log(`seeded ${users} runner users with ${seedBalance} USD`);
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { env, shell: false });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
    });

    child.on('error', reject);
    child.on('close', (code) => resolveCommand({ stdout, stderr, code }));
  });
}

function parseBenchmarkJson(stdout: string): BenchmarkOutput {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`could not parse benchmark JSON from output:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(start, end + 1)) as BenchmarkOutput;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function toCsv(results: ComparisonResult[]): string {
  const rows = [
    [
      'service',
      'api_url',
      'clients',
      'rounds_per_client',
      'total_requests',
      'throughput_rps',
      'elapsed_seconds',
      'failures',
      'retry_attempts',
      'p50_ms',
      'p95_ms',
      'p99_ms',
      'max_ms'
    ],
    ...results.map((result) => [
      result.service,
      result.apiUrl,
      result.clients,
      result.roundsPerClient,
      result.totalRequests,
      result.throughput,
      result.elapsedSeconds,
      result.failures,
      result.retryAttempts,
      result.latencyMs.p50,
      result.latencyMs.p95,
      result.latencyMs.p99,
      result.latencyMs.max
    ])
  ];

  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function csvCell(value: string | number): string {
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function toHtml(report: ComparisonReport): string {
  const results = [...report.results].sort((a, b) => a.clients - b.clients || a.service.localeCompare(b.service));
  const services = [...new Set(results.map((result) => result.service))];
  const colors = ['#2563eb', '#dc2626', '#059669', '#9333ea', '#d97706'];

  const throughputChart = lineChart({
    title: 'Throughput by Concurrent Clients',
    xLabel: 'Concurrent clients',
    yLabel: 'Requests per second',
    services,
    colors,
    results,
    metric: (result) => result.throughput,
    format: (value) => value.toFixed(0)
  });

  const p50Chart = lineChart({
    title: 'Median Latency',
    xLabel: 'Concurrent clients',
    yLabel: 'Latency ms',
    services,
    colors,
    results,
    metric: (result) => result.latencyMs.p50,
    format: (value) => value.toFixed(0)
  });

  const p95Chart = lineChart({
    title: 'P95 Latency',
    xLabel: 'Concurrent clients',
    yLabel: 'Latency ms',
    services,
    colors,
    results,
    metric: (result) => result.latencyMs.p95,
    format: (value) => value.toFixed(0)
  });

  const maxLoad = Math.max(...report.config.loadLevels);
  const maxLoadResults = results.filter((result) => result.clients === maxLoad);
  const fastest = maxLoadResults.reduce<ComparisonResult | undefined>(
    (best, result) => (best === undefined || result.throughput > best.throughput ? result : best),
    undefined
  );

  const comparisonText = fastest
    ? `At ${maxLoad} clients, ${escapeHtml(fastest.service)} reached ${fastest.throughput.toFixed(0)} req/s with p50 ${fastest.latencyMs.p50.toFixed(0)} ms.`
    : 'No max-load result available yet.';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TypeScript vs Rust Benchmark</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #172033;
      background: #f5f7fb;
    }
    body {
      margin: 0;
    }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 32px 20px 44px;
    }
    header {
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 32px;
      line-height: 1.15;
    }
    p {
      margin: 0;
      color: #536078;
      line-height: 1.5;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 16px;
    }
    .pill {
      border: 1px solid #d8dfec;
      background: #ffffff;
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 13px;
      color: #38445c;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
    }
    .panel {
      background: #ffffff;
      border: 1px solid #dce3ef;
      border-radius: 8px;
      padding: 18px;
      box-shadow: 0 10px 24px rgba(23, 32, 51, 0.06);
    }
    .panel.wide {
      grid-column: 1 / -1;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 18px;
    }
    svg {
      width: 100%;
      height: auto;
      display: block;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      border-bottom: 1px solid #e5ebf4;
      padding: 9px 8px;
      text-align: right;
      white-space: nowrap;
    }
    th:first-child, td:first-child {
      text-align: left;
    }
    th {
      color: #536078;
      font-weight: 650;
    }
    @media (max-width: 800px) {
      .grid {
        grid-template-columns: 1fr;
      }
      .panel {
        overflow-x: auto;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>TypeScript vs Rust Load Comparison</h1>
      <p>${comparisonText}</p>
      <div class="meta">
        <span class="pill">Generated ${escapeHtml(report.generatedAt)}</span>
        <span class="pill">${report.config.roundsPerClient} rounds/client</span>
        <span class="pill">${report.config.users} seeded users</span>
        <span class="pill">${report.config.maxSockets} client sockets</span>
        <span class="pill">${report.config.retries} retries</span>
      </div>
    </header>
    <section class="grid">
      <article class="panel wide">
        <h2>Throughput</h2>
        ${throughputChart}
      </article>
      <article class="panel">
        <h2>P50 Latency</h2>
        ${p50Chart}
      </article>
      <article class="panel">
        <h2>P95 Latency</h2>
        ${p95Chart}
      </article>
      <article class="panel wide">
        <h2>Raw Results</h2>
        ${resultsTable(results)}
      </article>
    </section>
  </main>
</body>
</html>
`;
}

type ChartOptions = {
  title: string;
  xLabel: string;
  yLabel: string;
  services: string[];
  colors: string[];
  results: ComparisonResult[];
  metric: (result: ComparisonResult) => number;
  format: (value: number) => string;
};

function lineChart(options: ChartOptions): string {
  const width = 920;
  const height = 360;
  const left = 72;
  const right = 24;
  const top = 24;
  const bottom = 58;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const xs = [...new Set(options.results.map((result) => result.clients))].sort((a, b) => a - b);
  const values = options.results.map(options.metric);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...values, 1);
  const yMax = niceCeil(maxY);

  const xScale = (x: number) => left + (maxX === minX ? plotWidth / 2 : ((x - minX) / (maxX - minX)) * plotWidth);
  const yScale = (y: number) => top + plotHeight - (y / yMax) * plotHeight;

  const yTicks = Array.from({ length: 5 }, (_, index) => (yMax / 4) * index);
  const grid = yTicks.map((tick) => {
    const y = yScale(tick);
    return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" stroke="#e5ebf4"/><text x="${left - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="#667085">${escapeHtml(options.format(tick))}</text>`;
  }).join('');

  const xTicks = xs.map((tick) => {
    const x = xScale(tick);
    return `<line x1="${x}" y1="${top + plotHeight}" x2="${x}" y2="${top + plotHeight + 5}" stroke="#98a2b3"/><text x="${x}" y="${height - 24}" text-anchor="middle" font-size="12" fill="#667085">${tick}</text>`;
  }).join('');

  const lines = options.services.map((service, index) => {
    const color = options.colors[index % options.colors.length];
    const serviceResults = options.results
      .filter((result) => result.service === service)
      .sort((a, b) => a.clients - b.clients);
    const points = serviceResults.map((result) => `${xScale(result.clients)},${yScale(options.metric(result))}`).join(' ');
    const dots = serviceResults.map((result) => {
      const x = xScale(result.clients);
      const y = yScale(options.metric(result));
      return `<circle cx="${x}" cy="${y}" r="4" fill="${color}"><title>${escapeHtml(service)} ${result.clients} clients: ${escapeHtml(options.format(options.metric(result)))}</title></circle>`;
    }).join('');
    return `<polyline fill="none" stroke="${color}" stroke-width="3" points="${points}"/>${dots}`;
  }).join('');

  const legend = options.services.map((service, index) => {
    const x = left + index * 155;
    const y = 18;
    const color = options.colors[index % options.colors.length];
    return `<circle cx="${x}" cy="${y}" r="5" fill="${color}"/><text x="${x + 10}" y="${y + 4}" font-size="13" fill="#344054">${escapeHtml(service)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title)}">
    ${grid}
    <line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" stroke="#98a2b3"/>
    <line x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}" stroke="#98a2b3"/>
    ${xTicks}
    ${lines}
    ${legend}
    <text x="${width / 2}" y="${height - 4}" text-anchor="middle" font-size="12" fill="#667085">${escapeHtml(options.xLabel)}</text>
    <text x="18" y="${top + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 18 ${top + plotHeight / 2})" font-size="12" fill="#667085">${escapeHtml(options.yLabel)}</text>
  </svg>`;
}

function resultsTable(results: ComparisonResult[]): string {
  const rows = results.map((result) => `<tr>
    <td>${escapeHtml(result.service)}</td>
    <td>${result.clients}</td>
    <td>${result.totalRequests}</td>
    <td>${result.throughput.toFixed(1)}</td>
    <td>${result.elapsedSeconds.toFixed(2)}</td>
    <td>${result.latencyMs.p50.toFixed(1)}</td>
    <td>${result.latencyMs.p95.toFixed(1)}</td>
    <td>${result.latencyMs.p99.toFixed(1)}</td>
    <td>${result.failures}</td>
  </tr>`).join('');

  return `<table>
    <thead>
      <tr>
        <th>Service</th>
        <th>Clients</th>
        <th>Requests</th>
        <th>Req/s</th>
        <th>Seconds</th>
        <th>P50</th>
        <th>P95</th>
        <th>P99</th>
        <th>Failures</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function niceCeil(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function main() {
  await mkdir(reportDir, { recursive: true });

  const results: ComparisonResult[] = [];
  for (const [loadIndex, clients] of loadLevels.entries()) {
    const orderedTargets = alternateTargetOrder && loadIndex % 2 === 1 ? [...targets].reverse() : targets;
    for (const target of orderedTargets) {
      if (cleanSeedBeforeEach) await cleanAndSeed(target, clients);
      console.log(`\n=== ${target.name} at ${clients} clients ===`);
      const benchmark = await runBenchmark(target, clients);
      results.push({ ...benchmark, service: target.name, apiUrl: target.apiUrl });
      if (cooldownMs > 0) await sleep(cooldownMs);
    }
  }

  const report: ComparisonReport = {
    generatedAt: new Date().toISOString(),
    config: {
      loadLevels,
      roundsPerClient,
      users,
      retries,
      maxSockets,
      requestTimeoutMs,
      alternateTargetOrder,
      cleanSeedBeforeEach,
      cooldownMs,
      databaseUrl,
      seedBalance,
      targets
    },
    results
  };

  const stamp = report.generatedAt.replaceAll(':', '-').replaceAll('.', '-');
  const jsonPath = resolve(reportDir, `benchmark-comparison-${stamp}.json`);
  const csvPath = resolve(reportDir, `benchmark-comparison-${stamp}.csv`);
  const htmlPath = resolve(reportDir, `benchmark-comparison-${stamp}.html`);
  const latestJsonPath = resolve(reportDir, 'benchmark-comparison-latest.json');
  const latestCsvPath = resolve(reportDir, 'benchmark-comparison-latest.csv');
  const latestHtmlPath = resolve(reportDir, 'benchmark-comparison-latest.html');

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(csvPath, toCsv(results));
  await writeFile(htmlPath, toHtml(report));
  await writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(latestCsvPath, toCsv(results));
  await writeFile(latestHtmlPath, toHtml(report));

  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${csvPath}`);
  console.log(`Wrote ${htmlPath}`);
  console.log(`Updated ${latestHtmlPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

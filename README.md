# Yeet Casino Bet Processor

Production-style casino bet processor in Node.js, TypeScript, and PostgreSQL.

## Architecture: Account-Striped Ledger

This is intentionally not a CRUD `users.balance` design. The durable business record is an append-only, monthly partitioned `actions` ledger; `accounts.balance` is a locked, derived account-state boundary used to make non-negative balance checks cheap and serializable per `(user_id, currency)`.

The processing path acts like a single writer per account/currency:

1. Open one PostgreSQL transaction.
2. Create the account row if needed and `SELECT ... FOR UPDATE`.
3. Process request actions in order.
4. Claim `action_id` in `action_registry` as first-result-wins idempotency.
5. Append new action rows into the monthly `actions` partition and enqueue lightweight RTP outbox deltas in the same transaction.
6. Persist the final derived balance and commit.
7. A background worker batches `rtp_outbox` rows into `rtp_user_minute` rollups.

Unrelated users run in parallel; one user/currency is serialized. That keeps the take-home focused on database-backed correctness without adding queues or a custom worker fleet.

## Invariants

- HMAC-SHA256 is verified over raw request bytes.
- Signature comparison uses `crypto.timingSafeEqual`.
- `action_id` is globally unique in `action_registry`; duplicates replay the original `tx_id`.
- A request is atomic; any insufficient-funds action rolls back all actions in that request.
- `accounts.balance` has a database `CHECK (balance >= 0)`.
- Rollbacks never reverse an original more than once because `rollback_intents.original_action_id` is unique.
- Pre-rollbacks insert a rollback tombstone; a later original action becomes `noop_prerolled` but still gets a `tx_id`.
- RTP outbox events are committed transactionally with action writes; rollups are updated asynchronously in batches.

## Schema

Core tables:

- `accounts(user_id, currency, balance)`: derived state and lock boundary.
- `action_registry(action_id, tx_id, user_id, currency, ledger_created_at)`: global idempotency table. This stays outside the partitioned ledger because PostgreSQL cannot enforce `UNIQUE(action_id)` globally on a range-partitioned table unless the partition key is also part of the unique constraint.
- `actions(action_id, tx_id, account_hash, user_id, currency, game, game_id, action_type, amount, original_action_id, balance_delta, status, rolled_back_by, created_at)`: immutable monthly partitioned action history plus rollback metadata.
- `rollback_intents(original_action_id, rollback_action_id)`: tombstones and one-rollback-only guard.
- `rtp_outbox(...)`: committed reporting deltas produced by the wallet transaction and drained by the rollup worker.
- `rtp_user_minute(bucket_minute, user_id, currency, total_bet, total_win, rounds, rollback_count, rolled_back_bet, rolled_back_win)`: incremental reporting fact table.

Partitioning:

- `actions` is `PARTITION BY RANGE (created_at)`.
- `ensure_actions_month_partition(ts)` creates monthly partitions such as `actions_2026_06`.
- The app calls that function before inserting a ledger row, and migration pre-creates the current and next month.
- `actions.account_hash = hashtext(user_id || ':' || currency)` is indexed with `created_at` so account-scoped history in hot operational ranges has a narrow access path.

Future scale notes:

- Partition `rtp_user_minute` by time; reports should hit rollups, not raw action history.
- If request volume outgrows a single API instance, scale stateless API replicas horizontally while keeping `(user_id, currency)` serialized by the account row lock.

## API

All routes require:

```text
Authorization: HMAC-SHA256 <hex-digest>
```

The digest is `hex(HMAC_SHA256(secret, raw request body bytes))`. For GET requests, sign the empty body.

### Process

`POST /aggregator/takehome/process`

Balance-only request:

```json
{ "user_id": "8|USDT|USD", "currency": "USD", "game": "acceptance:test" }
```

Action request:

```json
{
  "user_id": "8|USDT|USD",
  "currency": "USD",
  "game": "acceptance:test",
  "game_id": "1761032910488163506",
  "actions": [
    { "action": "bet", "action_id": "7c8affbf-53fd-4fcc-b1ca-18118c5dd287", "amount": 100 },
    { "action": "win", "action_id": "86441c7a-560e-4501-b829-110af6a1b956", "amount": 250 }
  ]
}
```

Insufficient funds returns:

```json
{ "code": 100, "message": "Player has not enough funds to process an action" }
```

### Reports

`GET /reports/rtp/users?from=<iso>&to=<iso>&currency=USD&limit=100&offset=0`

`GET /reports/rtp/casino?from=<iso>&to=<iso>&currency=USD`

RTP is `total_win / total_bet`; it is `null` when `total_bet = 0`. Rollback counts and rolled-back bet/win values are reported separately.

Reports are eventually consistent. The wallet transaction commits ledger/balance/outbox together; the `rtp-worker` batches outbox rows into `rtp_user_minute`.

## Run

```bash
npm install
docker compose up -d db
npm run migrate
npm run seed
npm run dev
```

Docker API + DB:

```bash
docker compose up --build
```

Docker starts PostgreSQL, the API, and `rtp-worker`.

## Rust Service

A side-by-side Rust implementation lives in `rust-service/`. It uses the same PostgreSQL schema and implements the same API semantics:

- raw-body HMAC auth
- account row locking
- global idempotency through `action_registry`
- monthly partitioned `actions` ledger
- normal rollbacks and pre-rollbacks
- RTP outbox deltas on the request path, matching the TypeScript service
- RTP report endpoints

Run it beside the TypeScript service on port `3001`. Keep `rtp-worker` running if you want RTP reports to catch up while benchmarking Rust:

```bash
docker compose -f docker-compose.yml -f docker-compose.rust.yml up -d --build db rtp-worker rust-api
```

Or locally:

```bash
cd rust-service
DATABASE_URL=postgres://yeet:yeet@localhost:5432/yeet HMAC_SECRET=test RUST_PORT=3001 cargo run
```

Benchmark the Rust API with the same TypeScript load generator:

```bash
API_URL=http://localhost:3001 BENCH_USERS=10000 BENCH_CLIENTS=300 BENCH_ROUNDS_PER_CLIENT=200 BENCH_HTTP_SOCKETS=100 BENCH_RETRIES=2 npm run benchmark
```

Smoke test:

```bash
RAW='{"user_id":"8|USDT|USD","currency":"USD","game":"acceptance:test"}'
SIG=$(printf "%s" "$RAW" | openssl dgst -sha256 -hmac test -hex | awk '{print $2}')
curl -sS -X POST http://localhost:3001/aggregator/takehome/process \
  -H "content-type: application/json" \
  -H "Authorization: HMAC-SHA256 $SIG" \
  --data "$RAW"
```

Local API mode:

```bash
npm run dev
```

## Tests

```bash
docker compose up -d db
npm test
```

If you previously ran an older non-partitioned local schema from this take-home, reset the Compose volume once before rerunning tests:

```bash
docker compose down -v
docker compose up -d db
npm test
```

The functional tests follow the acceptance spec exactly:

- A: missing authorization.
- B: balance lookup.
- C: single bet.
- D: bet plus win in one call.
- E: insufficient funds and atomic rollback.
- F: bet then win in separate calls.
- G: bet then rollback.
- H: duplicate action id idempotency.
- I: rollback before original bet.
- J: rollbacks before bet and win.
- K: concurrent bets cannot overdraft one account.

The sample balances in the prompt are not globally sequential, so each scenario seeds the exact starting balance required to assert the documented final balance.

## Runner

Seed users first:

```bash
SEED_USERS=10000 SEED_BALANCE=1000000000 npm run seed
```

Run a randomized RTP simulation:

```bash
RUNNER_USERS=10000 RUNNER_ROUNDS=100000 RUNNER_CONCURRENCY=100 npm run runner:rtp
```

The runner uses variance: each round bets 100, then wins 475 with 20% probability. Expected global RTP is 95%, but individual users vary. By default it drains the RTP outbox before reading reports; set `RUNNER_DRAIN_RTP_OUTBOX=false` when you want to rely only on the background worker.

## Benchmark

```bash
docker compose up --build
SEED_USERS=10000 SEED_BALANCE=1000000000 npm run seed
BENCH_USERS=10000 BENCH_CLIENTS=300 BENCH_ROUNDS_PER_CLIENT=200 BENCH_HTTP_SOCKETS=100 BENCH_RETRIES=2 npm run benchmark
```

This starts hundreds of simulated clients concurrently. Each client sends signed rounds sequentially, while the load generator uses keep-alive sockets capped by `BENCH_HTTP_SOCKETS` so local Docker port-forwarding is not the thing being stress-tested. Network-level resets are retried and reported separately from HTTP responses. Record throughput plus p50/p95/p99/max latency, retry count, network errors, and status distribution.

## Bonus
Generate TypeScript vs Rust comparison charts across increasing load levels:

```bash
docker compose -f docker-compose.yml -f docker-compose.rust.yml up -d --build db api rtp-worker rust-api
BENCH_LOAD_LEVELS=50,100,200,300 BENCH_ROUNDS_PER_CLIENT=200 BENCH_USERS=10000 BENCH_SEED_BALANCE=1000000000 BENCH_HTTP_SOCKETS=100 BENCH_RETRIES=2 npm run benchmark:compare
open reports/benchmark-comparison-latest.html
```

The comparison command migrates, truncates benchmark tables, and seeds accounts before every individual measurement. It writes timestamped JSON, CSV, and standalone HTML files into `reports/`, plus `benchmark-comparison-latest.*` copies for quick viewing. It alternates target order by load level so one service does not always run first. Set `BENCH_CLEAN_SEED_BEFORE_EACH=false` to reuse one database across all runs. Override `BENCH_TARGETS` if either service is running on a different URL, for example `BENCH_TARGETS=typescript=http://localhost:3000,rust=http://localhost:3001`.

Example local comparison from a MacBook/Docker run:

![TypeScript vs Rust load comparison](docs/assets/typescript-vs-rust-load-comparison.png)

## Tradeoffs
- The rollup table is organized by the minute. For exact arbitrary sub-minute reporting, combine full rollup buckets with raw-edge scans.
- RTP reports are eventually consistent; the outbox worker is normally sub-second locally, but reports can lag during a write spike.
- Rollback of a previously paid win can fail with insufficient funds if the account already spent the win. That preserves the non-negative balance invariant.
- The process endpoint stays synchronous to match the acceptance contract; only reporting rollups move to background work.

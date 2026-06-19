# Rust Bet Processor

Side-by-side Rust implementation of the Yeet take-home processor.

It reuses the root `sql/schema.sql` and implements the same core semantics as the TypeScript service:

- `POST /aggregator/takehome/process`
- raw-body HMAC-SHA256 auth
- constant-time signature comparison
- balance lookup
- bet/win/rollback processing in request order
- global idempotency via `action_registry`
- pre-rollback tombstones
- per-account row locking with `SELECT ... FOR UPDATE`
- monthly partitioned `actions` ledger
- RTP outbox deltas on the request path, drained by the same `rtp-worker`
- RTP report endpoints

Run locally:

```bash
docker compose up -d db
cd rust-service
DATABASE_URL=postgres://yeet:yeet@localhost:5432/yeet HMAC_SECRET=test RUST_PORT=3001 cargo run
```

Run with Docker Compose from the repo root:

```bash
docker compose -f docker-compose.yml -f docker-compose.rust.yml up -d --build db rtp-worker rust-api
```

Benchmark with the shared TypeScript load generator:

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

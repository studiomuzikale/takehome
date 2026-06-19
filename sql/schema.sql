CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  user_id text NOT NULL,
  currency text NOT NULL,
  balance bigint NOT NULL CHECK (balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, currency)
);

CREATE TABLE IF NOT EXISTS action_registry (
  action_id uuid PRIMARY KEY,
  tx_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  currency text NOT NULL,
  ledger_created_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS actions (
  action_id uuid NOT NULL REFERENCES action_registry(action_id),
  tx_id uuid NOT NULL,
  account_hash integer NOT NULL,
  user_id text NOT NULL,
  currency text NOT NULL,
  game text NOT NULL,
  game_id text,
  action_type text NOT NULL CHECK (action_type IN ('bet', 'win', 'rollback')),
  amount bigint,
  original_action_id uuid,
  balance_delta bigint NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'applied',
      'noop_prerolled',
      'noop_tombstone',
      'noop_already_rolled_back',
      'noop_original_not_applied'
    )
  ),
  rolled_back_by uuid,
  rolled_back_at timestamptz,
  created_at timestamptz NOT NULL,
  CHECK (
    (action_type IN ('bet', 'win') AND amount IS NOT NULL AND amount > 0 AND original_action_id IS NULL)
    OR
    (action_type = 'rollback' AND amount IS NULL AND original_action_id IS NOT NULL)
  )
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS actions_default
  PARTITION OF actions DEFAULT;

CREATE INDEX IF NOT EXISTS action_registry_user_created_idx
  ON action_registry (user_id, currency, ledger_created_at);

CREATE INDEX IF NOT EXISTS actions_action_id_created_idx
  ON actions (action_id, created_at);

CREATE INDEX IF NOT EXISTS actions_account_hash_created_idx
  ON actions (account_hash, created_at);

CREATE INDEX IF NOT EXISTS actions_user_currency_created_idx
  ON actions (user_id, currency, created_at);

CREATE INDEX IF NOT EXISTS actions_game_round_idx
  ON actions (game, game_id);

CREATE INDEX IF NOT EXISTS actions_original_action_idx
  ON actions (original_action_id)
  WHERE original_action_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ensure_actions_month_partition(partition_ts timestamptz)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  partition_start timestamptz := date_trunc('month', partition_ts);
  partition_end timestamptz := date_trunc('month', partition_ts) + interval '1 month';
  partition_name text := format('actions_%s', to_char(partition_start, 'YYYY_MM'));
BEGIN
  IF to_regclass(partition_name) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF actions FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      partition_start,
      partition_end
    );
  END IF;
END;
$$;

SELECT ensure_actions_month_partition(now());
SELECT ensure_actions_month_partition(now() + interval '1 month');

CREATE TABLE IF NOT EXISTS rollback_intents (
  original_action_id uuid PRIMARY KEY,
  rollback_action_id uuid NOT NULL UNIQUE REFERENCES action_registry(action_id),
  user_id text NOT NULL,
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rtp_outbox (
  id bigserial PRIMARY KEY,
  bucket_minute timestamptz NOT NULL,
  user_id text NOT NULL,
  currency text NOT NULL,
  total_bet_delta bigint NOT NULL DEFAULT 0,
  total_win_delta bigint NOT NULL DEFAULT 0,
  rounds_delta bigint NOT NULL DEFAULT 0,
  rollback_count_delta bigint NOT NULL DEFAULT 0,
  rolled_back_bet_delta bigint NOT NULL DEFAULT 0,
  rolled_back_win_delta bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed')),
  attempts integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rtp_outbox_pending_idx
  ON rtp_outbox (id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS rtp_outbox_processing_locked_idx
  ON rtp_outbox (locked_at)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS rtp_user_minute (
  bucket_minute timestamptz NOT NULL,
  user_id text NOT NULL,
  currency text NOT NULL,
  total_bet bigint NOT NULL DEFAULT 0,
  total_win bigint NOT NULL DEFAULT 0,
  rounds bigint NOT NULL DEFAULT 0,
  rollback_count bigint NOT NULL DEFAULT 0,
  rolled_back_bet bigint NOT NULL DEFAULT 0,
  rolled_back_win bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_minute, user_id, currency)
);

CREATE INDEX IF NOT EXISTS rtp_user_minute_page_idx
  ON rtp_user_minute (user_id, currency, bucket_minute);

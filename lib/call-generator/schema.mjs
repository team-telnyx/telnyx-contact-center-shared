// Shared by the app and the independent generator executor. No provider I/O.
export async function ensureGeneratorRuntimeSchema(db) {
  await db.query(`
    ALTER TABLE cg_call_ledger ADD COLUMN IF NOT EXISTS dial_requested_at timestamptz;
    ALTER TABLE cg_call_ledger ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
    ALTER TABLE cg_call_ledger ADD COLUMN IF NOT EXISTS media_ended_at timestamptz;
    ALTER TABLE cg_call_ledger ADD COLUMN IF NOT EXISTS work_item_id uuid;
    ALTER TABLE cg_runs ADD COLUMN IF NOT EXISTS request_key text;
    ALTER TABLE cg_runs ADD COLUMN IF NOT EXISTS request_config jsonb;
    UPDATE cg_call_ledger SET media_ended_at=ended_at WHERE media_ended_at IS NULL AND result->>'event'='call.hangup';
    UPDATE cg_call_ledger SET dial_requested_at=COALESCE(started_at,created_at),
      deadline_at=COALESCE(started_at,created_at)+interval '1 hour'
      WHERE dial_requested_at IS NULL AND status IN ('dialing','ringing','answered','talking');
    CREATE UNIQUE INDEX IF NOT EXISTS cg_run_request_key ON cg_runs(request_key) WHERE request_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS cg_webhook_inbox (
      event_id text PRIMARY KEY, event_type text NOT NULL, payload jsonb NOT NULL,
      payload_hash text NOT NULL, occurred_at timestamptz, received_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz, outcome text, next_attempt_at timestamptz NOT NULL DEFAULT now(),
      attempts int NOT NULL DEFAULT 0, last_error text
    );
    CREATE INDEX IF NOT EXISTS cg_inbox_pending ON cg_webhook_inbox(next_attempt_at) WHERE processed_at IS NULL;
    CREATE TABLE IF NOT EXISTS cg_commands (
      id text PRIMARY KEY, ledger_id uuid NOT NULL REFERENCES cg_call_ledger(id) ON DELETE CASCADE,
      sequence int NOT NULL, action text NOT NULL, body jsonb NOT NULL DEFAULT '{}',
      status text NOT NULL DEFAULT 'pending', wait_event text, requested_at timestamptz,
      due_at timestamptz NOT NULL DEFAULT now(), deadline_at timestamptz,
      completed_at timestamptz, attempts int NOT NULL DEFAULT 0, last_error text,
      UNIQUE(ledger_id, sequence)
    );
    ALTER TABLE cg_commands DROP CONSTRAINT IF EXISTS cg_commands_ledger_id_fkey;
    ALTER TABLE cg_commands ADD CONSTRAINT cg_commands_ledger_id_fkey FOREIGN KEY(ledger_id) REFERENCES cg_call_ledger(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS cg_commands_pending ON cg_commands(ledger_id,sequence) WHERE completed_at IS NULL;
    ALTER TABLE cg_commands ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
    ALTER TABLE cg_commands ADD COLUMN IF NOT EXISTS playback_started_at timestamptz;
    ALTER TABLE cg_commands ADD COLUMN IF NOT EXISTS last_event_id text;
    ALTER TABLE cg_commands ADD COLUMN IF NOT EXISTS last_event_type text;
    ALTER TABLE cg_commands ADD COLUMN IF NOT EXISTS provider_status_detail text;
    CREATE TABLE IF NOT EXISTS cg_runtime_state (
      id text PRIMARY KEY, heartbeat_at timestamptz, node_id text, last_dial_at timestamptz
    );
    INSERT INTO cg_runtime_state(id) VALUES ('executor') ON CONFLICT DO NOTHING;
  `);
}

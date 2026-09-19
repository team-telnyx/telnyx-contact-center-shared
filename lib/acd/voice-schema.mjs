// Idempotent voice reliability migration for the Core-only runtime.
export async function ensureVoiceSchema(db) {
  await db.query(`
    ALTER TABLE acd_legs ADD COLUMN IF NOT EXISTS agent_id TEXT;
    ALTER TABLE acd_legs ADD COLUMN IF NOT EXISTS bridged_peer_call_id TEXT;
    ALTER TABLE acd_legs ADD COLUMN IF NOT EXISTS bridged_event_id TEXT;
    ALTER TABLE acd_legs DROP CONSTRAINT IF EXISTS acd_legs_role_check;
    ALTER TABLE acd_legs ADD CONSTRAINT acd_legs_role_check CHECK (role IN
      ('customer', 'agent_transport', 'agent_device', 'consult_target', 'consult_transport', 'transfer_target', 'transfer_transport', 'supervisor'));
    ALTER TABLE acd_work_items ADD COLUMN IF NOT EXISTS provider_session_id TEXT;
    ALTER TABLE acd_work_items ADD COLUMN IF NOT EXISTS handoff_saga_id UUID;
    ALTER TABLE acd_work_items ADD COLUMN IF NOT EXISTS outbound_attempt_id TEXT;
    UPDATE acd_work_items SET provider_session_id = attributes->>'call_session_id'
      WHERE provider_session_id IS NULL;
    UPDATE acd_work_items SET handoff_saga_id = (attributes->>'handoff_saga_id')::uuid
      WHERE handoff_saga_id IS NULL AND attributes->>'handoff_saga_id' ~ '^[0-9a-fA-F-]{36}$';
    UPDATE acd_work_items
       SET attributes = attributes - 'handoff_pending' - 'handoff_saga_id'
     WHERE attributes ? 'handoff_pending' OR attributes ? 'handoff_saga_id';
    CREATE INDEX IF NOT EXISTS acd_wi_session ON acd_work_items (provider_session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS acd_wi_outbound_attempt ON acd_work_items (outbound_attempt_id) WHERE outbound_attempt_id IS NOT NULL;
    ALTER TABLE acd_agent_state ADD COLUMN IF NOT EXISTS manual_status TEXT NOT NULL DEFAULT 'Available';
    ALTER TABLE acd_agent_state ADD COLUMN IF NOT EXISTS workflow_work_item_id UUID;
    ALTER TABLE acd_agent_state ADD COLUMN IF NOT EXISTS status_started_at TIMESTAMPTZ NOT NULL DEFAULT now();
    UPDATE acd_agent_state SET status_started_at = COALESCE(status_started_at, updated_at, now());
    ALTER TABLE acd_segments ADD COLUMN IF NOT EXISTS wrapup_deadline_at TIMESTAMPTZ;
    ALTER TABLE acd_reservations ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'queue';
    ALTER TABLE acd_reservations ADD COLUMN IF NOT EXISTS release_requested_at TIMESTAMPTZ;
    ALTER TABLE acd_reservations ADD COLUMN IF NOT EXISTS release_requested_reason TEXT;
    DROP INDEX IF EXISTS acd_res_one_per_work_item;
    CREATE UNIQUE INDEX IF NOT EXISTS acd_res_one_per_agent_work_item
      ON acd_reservations (work_item_id, agent_id) WHERE state IN ('reserved', 'ringing', 'active');
    UPDATE acd_agent_state a SET workflow_work_item_id = e.work_item_id
      FROM (SELECT DISTINCT ON (agent_id) agent_id, work_item_id FROM acd_events
        WHERE type = 'agent_workflow_changed' ORDER BY agent_id, id DESC) e
      WHERE a.agent_id = e.agent_id AND a.workflow_work_item_id IS NULL;
    UPDATE acd_segments s SET wrapup_deadline_at = a.workflow_deadline_at
      FROM acd_agent_state a WHERE s.agent_id = a.agent_id AND s.work_item_id = a.workflow_work_item_id
        AND s.ended_at IS NOT NULL AND s.wrapup_ended_at IS NULL AND s.wrapup_deadline_at IS NULL;
    ALTER TABLE acd_sagas ADD COLUMN IF NOT EXISTS last_driven_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS acd_sagas_fair_drive ON acd_sagas (last_driven_at NULLS FIRST) WHERE state IN ('running','compensating');
    ALTER TABLE acd_webhook_events ADD COLUMN IF NOT EXISTS source_route TEXT;
    ALTER TABLE acd_webhook_events ADD COLUMN IF NOT EXISTS source_flow_id TEXT;
    CREATE TABLE IF NOT EXISTS acd_stream_events (
      seq BIGSERIAL PRIMARY KEY,
      outbox_seq BIGINT UNIQUE NOT NULL,
      event_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS acd_stream_time ON acd_stream_events (created_at);
    CREATE TABLE IF NOT EXISTS acd_retention_watermarks (
      layer TEXT PRIMARY KEY CHECK (layer IN ('acd_events','acd_outbox','acd_stream_events')),
      last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      cutoff_at TIMESTAMPTZ,
      last_deleted_count BIGINT NOT NULL DEFAULT 0,
      total_deleted_count BIGINT NOT NULL DEFAULT 0,
      oldest_retained_sequence BIGINT,
      latest_sequence BIGINT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS acd_operator_actions (
      request_id UUID PRIMARY KEY,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      result JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS acd_outbound_lines (
      attempt_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, work_item_id UUID NOT NULL,
      owner_saga_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      released_at TIMESTAMPTZ, release_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS acd_outbound_live_lines ON acd_outbound_lines (campaign_id) WHERE released_at IS NULL;
    CREATE TABLE IF NOT EXISTS acd_outbound_schedule (campaign_id TEXT PRIMARY KEY, polled_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS acd_direct_intents (
      id UUID PRIMARY KEY, agent_id TEXT NOT NULL, reservation_id UUID NOT NULL,
      work_item_id UUID REFERENCES acd_work_items(id),
      target TEXT NOT NULL, purpose TEXT NOT NULL,
      provider_call_id TEXT UNIQUE, provider_session_id TEXT,
      state TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ
    );
    ALTER TABLE acd_direct_intents ADD COLUMN IF NOT EXISTS work_item_id UUID REFERENCES acd_work_items(id);
    ALTER TABLE acd_direct_intents ADD COLUMN IF NOT EXISTS alarm_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS acd_action_requests (
      request_id UUID PRIMARY KEY, agent_id TEXT NOT NULL, work_item_id UUID NOT NULL,
      action TEXT NOT NULL, fingerprint TEXT NOT NULL, saga_id UUID NOT NULL
    );
    CREATE INDEX IF NOT EXISTS acd_direct_session ON acd_direct_intents (provider_session_id);
    CREATE INDEX IF NOT EXISTS acd_direct_work_item ON acd_direct_intents (work_item_id);
    -- Read on every capacity attempt: a revoked intent whose leg has not been
    -- confirmed gone still occupies its agent. Without this the arbiter scans
    -- the whole intent history on the routing hot path.
    CREATE INDEX IF NOT EXISTS acd_direct_revoked_live ON acd_direct_intents (agent_id)
      WHERE state = 'revoked' AND provider_call_id IS NOT NULL AND ended_at IS NULL;
  `);
}

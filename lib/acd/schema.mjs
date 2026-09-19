// ACD Core schema — the internal documentation §3.
// Idempotent Core-only schema, safe to run on every boot.

import { ensureVoiceSchema } from "./voice-schema.mjs";
import { ensureAcdArtifactSchema } from "./artifact-schema.mjs";
import { ensureAcdHistorySchema } from "./history-schema.mjs";
import { ensureSlaSchema } from "./sla-schema.mjs";
import { ensureMessagingSchema } from "./messaging-schema.mjs";

export async function ensureAcdSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS acd_work_items (
      id               UUID PRIMARY KEY,
      version          BIGINT NOT NULL DEFAULT 0,
      channel          TEXT NOT NULL,
      direction        TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
      state            TEXT NOT NULL DEFAULT 'open'
                       CHECK (state IN ('open', 'queued', 'offered', 'active', 'completed', 'abandoned', 'failed')),
      queue_id         TEXT,
      priority         INT NOT NULL DEFAULT 0,
      required_skills  JSONB NOT NULL DEFAULT '{}',
      customer_address TEXT,
      cc_address       TEXT,
      attributes       JSONB NOT NULL DEFAULT '{}',
      enqueued_at      TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      terminal_at      TIMESTAMPTZ,
      terminal_reason  TEXT
    );

    CREATE INDEX IF NOT EXISTS acd_wi_queued
      ON acd_work_items (queue_id, priority DESC, enqueued_at)
      WHERE state = 'queued';
    CREATE INDEX IF NOT EXISTS acd_wi_nonterminal
      ON acd_work_items (state) WHERE terminal_at IS NULL;
    CREATE TABLE IF NOT EXISTS acd_segments (
      id            UUID PRIMARY KEY,
      work_item_id  UUID NOT NULL REFERENCES acd_work_items(id),
      seq           INT  NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN ('queue_wait', 'agent', 'ai_assistant', 'flow', 'park')),
      queue_id      TEXT,
      agent_id      TEXT,
      started_at    TIMESTAMPTZ NOT NULL,
      answered_at   TIMESTAMPTZ,
      ended_at      TIMESTAMPTZ,
      outcome       TEXT CHECK (outcome IS NULL OR outcome IN
                      ('answered', 'no_answer', 'abandoned', 'transferred', 'completed', 'failed', 'cancelled')),
      wrapup_code_id  TEXT,
      wrapup_ended_at TIMESTAMPTZ,
      UNIQUE (work_item_id, seq)
    );

    CREATE INDEX IF NOT EXISTS acd_seg_open
      ON acd_segments (work_item_id) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS acd_seg_agent
      ON acd_segments (agent_id) WHERE agent_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS acd_legs (
      id                  UUID PRIMARY KEY,
      work_item_id        UUID NOT NULL REFERENCES acd_work_items(id),
      role                TEXT NOT NULL CHECK (role IN
                            ('customer', 'agent_transport', 'agent_device', 'consult_target',
                             'consult_transport', 'transfer_target', 'transfer_transport', 'supervisor')),
      provider_call_id    TEXT UNIQUE,
      provider_session_id TEXT,
      rtc_session_id      TEXT,
      offer_generation    BIGINT,
      owner_saga_id       UUID,
      state               TEXT NOT NULL CHECK (state IN
                            ('dialing', 'ringing', 'answered', 'held', 'parked', 'bridged', 'ended')),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      answered_at         TIMESTAMPTZ,
      bridged_at          TIMESTAMPTZ,
      ended_at            TIMESTAMPTZ,
      ended_reason        TEXT
    );

    CREATE INDEX IF NOT EXISTS acd_leg_work_item ON acd_legs (work_item_id);
    CREATE INDEX IF NOT EXISTS acd_leg_session
      ON acd_legs (provider_session_id) WHERE provider_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS acd_leg_live
      ON acd_legs (state) WHERE ended_at IS NULL;

    -- A Call Control Dial to a WebRTC user creates two provider legs: the
    -- outbound transport returned by Dial and the inbound device leg carrying
    -- our custom headers. They have different lifetimes and must not share the
    -- consult_target role, otherwise the transport's normal hangup at answer
    -- is mistaken for the consultant leaving the call.
    ALTER TABLE acd_legs DROP CONSTRAINT IF EXISTS acd_legs_role_check;
    ALTER TABLE acd_legs ADD CONSTRAINT acd_legs_role_check CHECK (role IN
      ('customer', 'agent_transport', 'agent_device', 'consult_target',
       'consult_transport', 'transfer_target', 'transfer_transport', 'supervisor'));
    ALTER TABLE acd_legs ADD COLUMN IF NOT EXISTS bridged_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS acd_leg_intents (
      id                  UUID PRIMARY KEY,
      work_item_id        UUID NOT NULL REFERENCES acd_work_items(id),
      reservation_id      UUID,
      agent_id            TEXT,
      offer_generation    BIGINT NOT NULL,
      expected_role       TEXT NOT NULL,
      command_id          TEXT NOT NULL,
      state               TEXT NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'bound', 'expired', 'ambiguous', 'cancelled')),
      transport_call_id   TEXT,
      bound_leg_id        UUID,
      deadline_at         TIMESTAMPTZ NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (work_item_id, expected_role, offer_generation)
    );

    CREATE INDEX IF NOT EXISTS acd_leg_intent_pending
      ON acd_leg_intents (agent_id, state) WHERE state = 'pending';

    CREATE TABLE IF NOT EXISTS acd_offers (
      id              UUID PRIMARY KEY,
      work_item_id    UUID NOT NULL REFERENCES acd_work_items(id),
      agent_id        TEXT NOT NULL,
      generation      BIGINT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'created'
                      CHECK (state IN ('created', 'ringing', 'accepted', 'rejected', 'no_answer', 'cancelled')),
      deadline_at     TIMESTAMPTZ NOT NULL,
      outcome_reason  TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      terminal_at     TIMESTAMPTZ,
      UNIQUE (work_item_id, generation)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS acd_offer_one_live
      ON acd_offers (work_item_id) WHERE state IN ('created', 'ringing', 'accepted');
    CREATE INDEX IF NOT EXISTS acd_offer_agent_live
      ON acd_offers (agent_id) WHERE state IN ('created', 'ringing');

    CREATE TABLE IF NOT EXISTS acd_reservations (
      id               UUID PRIMARY KEY,
      agent_id         TEXT NOT NULL,
      work_item_id     UUID,
      attempt_id       TEXT,
      channel          TEXT NOT NULL,
      weight           NUMERIC(4,2) NOT NULL DEFAULT 1.0,
      state            TEXT NOT NULL CHECK (state IN ('reserved', 'ringing', 'active', 'released')),
      lease_expires_at TIMESTAMPTZ,
      handling_session_id UUID,
      last_provider_event_at TIMESTAMPTZ,
      owner_saga_id    UUID,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      released_at      TIMESTAMPTZ,
      released_reason  TEXT,
      CONSTRAINT acd_res_lease_on_claims CHECK (
        state IN ('active', 'released') OR lease_expires_at IS NOT NULL
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS acd_res_one_per_agent_work_item
      ON acd_reservations (work_item_id, agent_id) WHERE state IN ('reserved', 'ringing', 'active');
    CREATE INDEX IF NOT EXISTS acd_res_agent_live
      ON acd_reservations (agent_id) WHERE state <> 'released';
    CREATE INDEX IF NOT EXISTS acd_res_attempt
      ON acd_reservations (attempt_id) WHERE attempt_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS acd_res_lease_sweep
      ON acd_reservations (lease_expires_at) WHERE state IN ('reserved', 'ringing');

    CREATE TABLE IF NOT EXISTS acd_agent_state (
      agent_id       TEXT PRIMARY KEY,
      presence       TEXT NOT NULL DEFAULT 'offline' CHECK (presence IN ('online', 'offline')),
      routability    TEXT NOT NULL DEFAULT 'not_routable' CHECK (routability IN ('routable', 'not_routable')),
      status_id      TEXT,
      manual_status  TEXT NOT NULL DEFAULT 'Available',
      workflow_state TEXT NOT NULL DEFAULT 'idle'
                     CHECK (workflow_state IN ('idle', 'offered', 'handling', 'wrapup')),
      workflow_deadline_at TIMESTAMPTZ,
      workflow_work_item_id UUID,
      status_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      capacity       NUMERIC(4,2) NOT NULL DEFAULT 1.0,
      version        BIGINT NOT NULL DEFAULT 0,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE acd_agent_state ADD COLUMN IF NOT EXISTS manual_status_set_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS acd_agent_sessions (
      id            UUID PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      node_id       TEXT NOT NULL,
      device_id     TEXT,
      capabilities  JSONB NOT NULL DEFAULT '{}',
      state         TEXT NOT NULL CHECK (state IN ('online', 'offline', 'degraded')),
      heartbeat_at  TIMESTAMPTZ NOT NULL,
      expires_at    TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS acd_session_agent_live
      ON acd_agent_sessions (agent_id) WHERE state <> 'offline';

    CREATE TABLE IF NOT EXISTS acd_sagas (
      id               UUID PRIMARY KEY,
      type             TEXT NOT NULL,
      work_item_id     UUID NOT NULL,
      conflict_key     TEXT NOT NULL,
      state            TEXT NOT NULL DEFAULT 'running'
                       CHECK (state IN ('running', 'compensating', 'succeeded', 'failed', 'cancelled')),
      step             TEXT NOT NULL,
      step_sequence    BIGINT NOT NULL DEFAULT 0,
      data             JSONB NOT NULL DEFAULT '{}',
      deadline_at      TIMESTAMPTZ NOT NULL,
      lease_owner      TEXT,
      lease_expires_at TIMESTAMPTZ,
      attempt_count    INT NOT NULL DEFAULT 0,
      last_error       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      terminal_at      TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS acd_saga_one_active_effect
      ON acd_sagas (work_item_id, conflict_key) WHERE state IN ('running', 'compensating');
    CREATE INDEX IF NOT EXISTS acd_saga_due
      ON acd_sagas (deadline_at) WHERE state IN ('running', 'compensating');
    CREATE INDEX IF NOT EXISTS acd_saga_lease
      ON acd_sagas (lease_expires_at) WHERE state IN ('running', 'compensating');

    CREATE TABLE IF NOT EXISTS acd_commands (
      command_id    TEXT PRIMARY KEY,
      saga_id       UUID NOT NULL,
      step          TEXT NOT NULL,
      step_sequence BIGINT NOT NULL DEFAULT 0,
      provider      TEXT NOT NULL DEFAULT 'telnyx',
      operation     TEXT NOT NULL,
      target_leg_id UUID,
      endpoint      TEXT NOT NULL,
      request       JSONB NOT NULL,
      request_hash  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned', 'sent', 'accepted', 'confirmed', 'failed', 'ambiguous')),
      response      JSONB,
      http_status   INT,
      attempt_count INT NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ,
      deadline_at   TIMESTAMPTZ NOT NULL,
      accepted_at   TIMESTAMPTZ,
      confirmed_at  TIMESTAMPTZ,
      confirmation_event_id TEXT,
      last_error    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS acd_cmd_saga ON acd_commands (saga_id);
    CREATE INDEX IF NOT EXISTS acd_cmd_unresolved
      ON acd_commands (status) WHERE status IN ('sent', 'ambiguous');

    ALTER TABLE acd_sagas
      ADD COLUMN IF NOT EXISTS step_sequence BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE acd_commands
      ADD COLUMN IF NOT EXISTS step_sequence BIGINT NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS acd_events (
      id           BIGSERIAL PRIMARY KEY,
      work_item_id UUID,
      agent_id     TEXT,
      type         TEXT NOT NULL,
      payload      JSONB NOT NULL DEFAULT '{}',
      actor        TEXT NOT NULL,
      occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS acd_event_work_item
      ON acd_events (work_item_id, id) WHERE work_item_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS acd_event_type_time ON acd_events (type, occurred_at);

    CREATE TABLE IF NOT EXISTS acd_webhook_events (
      event_id     TEXT PRIMARY KEY,
      provider     TEXT NOT NULL DEFAULT 'telnyx',
      event_type   TEXT NOT NULL,
      occurred_at  TIMESTAMPTZ,
      payload      JSONB NOT NULL,
      payload_hash TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received', 'processing', 'applied', 'noop', 'unmatched',
                                     'retryable_failed', 'dead')),
      attempt_count INT NOT NULL DEFAULT 0,
      lease_owner  TEXT,
      lease_expires_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ,
      last_error   TEXT,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS acd_inbox_claimable
      ON acd_webhook_events (received_at)
      WHERE status IN ('received', 'retryable_failed');

    CREATE TABLE IF NOT EXISTS voice_webhook_dedupe (
      event_id   TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS voice_webhook_dedupe_kind_time
      ON voice_webhook_dedupe (kind, created_at);

    CREATE TABLE IF NOT EXISTS acd_outbox (
      seq        BIGSERIAL PRIMARY KEY,
      event_id   BIGINT NOT NULL REFERENCES acd_events(id),
      topic      TEXT NOT NULL,
      payload    JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS acd_outbox_topic ON acd_outbox (topic, seq);
  `);

  await ensureVoiceSchema(client);
  await ensureMessagingSchema(client);
  await ensureSlaSchema(client);
  await ensureAcdArtifactSchema(client);
  await ensureAcdHistorySchema(client);
}

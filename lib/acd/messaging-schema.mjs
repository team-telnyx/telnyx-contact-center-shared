import { ensureWidgetSchema } from "../widgets/schema.mjs";
import { ensureEmailSchema } from "../email/schema.mjs";
import { ensureSmsSchema } from "../sms/schema.mjs";
import { ensureWhatsAppSchema } from "../whatsapp/schema.mjs";
import { ensureVideoSchema } from "../video/schema.mjs";

// Additive configuration and native text storage. Voice state remains in Core.
export async function ensureMessagingSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_queue_channels (
      queue_id TEXT NOT NULL REFERENCES cc_queues(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel ~ '^[a-z][a-z0-9_]*$'),
      enabled BOOLEAN NOT NULL DEFAULT false,
      max_concurrent INT NOT NULL CHECK (max_concurrent BETWEEN 1 AND 100),
      weight NUMERIC(4,2) NOT NULL CHECK (weight > 0 AND weight <= 1),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (queue_id, channel)
    );
    CREATE TABLE IF NOT EXISTS cc_agent_utilization (
      agent_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      budget NUMERIC(4,2) NOT NULL DEFAULT 1 CHECK (budget > 0 AND budget <= 1),
      version BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_agent_channel_policies (
      agent_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel ~ '^[a-z][a-z0-9_]*$'),
      enabled BOOLEAN NOT NULL DEFAULT false,
      max_concurrent INT NOT NULL CHECK (max_concurrent BETWEEN 1 AND 100),
      weight NUMERIC(4,2) NOT NULL CHECK (weight > 0 AND weight <= 1),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_id, channel)
    );
    ALTER TABLE cc_queue_channels DROP CONSTRAINT IF EXISTS cc_queue_channels_channel_check;
    ALTER TABLE cc_queue_channels ADD CONSTRAINT cc_queue_channels_channel_check CHECK(channel ~ '^[a-z][a-z0-9_]*$');
    ALTER TABLE cc_agent_channel_policies DROP CONSTRAINT IF EXISTS cc_agent_channel_policies_channel_check;
    ALTER TABLE cc_agent_channel_policies ADD CONSTRAINT cc_agent_channel_policies_channel_check CHECK(channel ~ '^[a-z][a-z0-9_]*$');
    CREATE TABLE IF NOT EXISTS cc_agent_queue_channels (
      agent_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      queue_id TEXT NOT NULL REFERENCES cc_queues(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY (agent_id, queue_id, channel)
    );
    CREATE TABLE IF NOT EXISTS acd_conversations (
      id UUID PRIMARY KEY,
      channel TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
      customer_name TEXT NOT NULL DEFAULT 'Website visitor',
      attributes JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at TIMESTAMPTZ
    );
    ALTER TABLE acd_work_items ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES acd_conversations(id);
    CREATE UNIQUE INDEX IF NOT EXISTS acd_one_live_conversation_work
      ON acd_work_items(conversation_id) WHERE conversation_id IS NOT NULL AND terminal_at IS NULL;
    CREATE TABLE IF NOT EXISTS acd_messages (
      id UUID PRIMARY KEY,
      seq BIGSERIAL UNIQUE NOT NULL,
      conversation_id UUID NOT NULL REFERENCES acd_conversations(id),
      work_item_id UUID NOT NULL REFERENCES acd_work_items(id),
      sender_role TEXT NOT NULL CHECK (sender_role IN ('customer','agent','system')),
      sender_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (conversation_id, sender_role, sender_id, client_id)
    );
    CREATE INDEX IF NOT EXISTS acd_message_conversation ON acd_messages(conversation_id,seq);
    CREATE TABLE IF NOT EXISTS acd_text_assignments (
      reservation_id UUID PRIMARY KEY REFERENCES acd_reservations(id),
      work_item_id UUID NOT NULL REFERENCES acd_work_items(id),
      agent_id TEXT NOT NULL,
      segment_id UUID NOT NULL REFERENCES acd_segments(id),
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','wrapup','completed')),
      wrapup_deadline_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      typing_until TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS acd_text_commands (
      work_item_id UUID NOT NULL REFERENCES acd_work_items(id),
      actor_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (work_item_id, actor_id, command_id)
    );
    CREATE TABLE IF NOT EXISTS acd_text_drafts (
      work_item_id UUID NOT NULL REFERENCES acd_work_items(id),
      agent_id TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      version BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (work_item_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS acd_chat_copilot_requests (
      work_item_id UUID NOT NULL REFERENCES acd_work_items(id),
      agent_id TEXT NOT NULL,
      request_id UUID NOT NULL,
      question_hash TEXT NOT NULL,
      question TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('processing','completed','failed')),
      response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(work_item_id,agent_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS acd_chat_copilot_agent_time ON acd_chat_copilot_requests(agent_id,created_at);
  `);
  await ensureWidgetSchema(db);
  await ensureEmailSchema(db);
  await ensureSmsSchema(db);
  await ensureWhatsAppSchema(db);
  await ensureVideoSchema(db);
}

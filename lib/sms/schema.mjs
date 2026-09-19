// Additive SMS adapter storage. Work, ownership and capacity remain in ACD Core;
// these tables hold provider identities, the inbound staging archive, thread
// identity per (business number, customer number) and per-message delivery state.
export async function ensureSmsSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_sms_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      webhook_url TEXT, webhook_failover_url TEXT, webhook_api_version TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      webhook_verified_at TIMESTAMPTZ, last_error TEXT,
      version BIGINT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_sms_numbers (
      id UUID PRIMARY KEY, phone_number TEXT NOT NULL UNIQUE,
      provider_number_id TEXT, messaging_profile_id TEXT REFERENCES cc_sms_profiles(id),
      name TEXT NOT NULL, queue_id TEXT NOT NULL REFERENCES cc_queues(id),
      routing_enabled BOOLEAN NOT NULL DEFAULT false,
      sending_enabled BOOLEAN NOT NULL DEFAULT false,
      country_code TEXT, number_type TEXT, last_error TEXT,
      version BIGINT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_sms_received (
      number_id UUID NOT NULL REFERENCES cc_sms_numbers(id),
      provider_message_id TEXT NOT NULL, customer_address TEXT NOT NULL,
      payload JSONB NOT NULL, classification TEXT NOT NULL DEFAULT 'customer',
      message_id UUID REFERENCES acd_messages(id),
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ,
      route_after TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(number_id,provider_message_id)
    );
    CREATE INDEX IF NOT EXISTS cc_sms_received_pending ON cc_sms_received(received_at) WHERE processed_at IS NULL;
    CREATE TABLE IF NOT EXISTS cc_sms_threads (
      conversation_id UUID PRIMARY KEY REFERENCES acd_conversations(id),
      number_id UUID NOT NULL REFERENCES cc_sms_numbers(id),
      customer_address TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','waiting','completed')),
      opted_out_at TIMESTAMPTZ, last_inbound_at TIMESTAMPTZ, last_outbound_at TIMESTAMPTZ,
      UNIQUE(number_id,customer_address)
    );
    CREATE TABLE IF NOT EXISTS cc_sms_messages (
      message_id UUID PRIMARY KEY REFERENCES acd_messages(id),
      number_id UUID NOT NULL REFERENCES cc_sms_numbers(id),
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
      provider_message_id TEXT, status TEXT NOT NULL DEFAULT 'received',
      encoding TEXT, parts INT, media JSONB NOT NULL DEFAULT '[]',
      error_code TEXT, error_detail TEXT, occurred_at TIMESTAMPTZ,
      saga_id UUID REFERENCES acd_sagas(id),
      next_delivery_sync_at TIMESTAMPTZ, delivery_sync_attempts INT NOT NULL DEFAULT 0,
      UNIQUE(number_id,provider_message_id)
    );
    CREATE INDEX IF NOT EXISTS cc_sms_messages_delivery_sync ON cc_sms_messages(next_delivery_sync_at) WHERE next_delivery_sync_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS cc_sms_templates (
      id UUID PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT 'marketing' CHECK(category IN ('marketing','utility','service')),
      language TEXT NOT NULL DEFAULT 'en', body TEXT NOT NULL,
      variables JSONB NOT NULL DEFAULT '[]', sample_values JSONB NOT NULL DEFAULT '{}',
      footer_mode TEXT NOT NULL DEFAULT 'inherit' CHECK(footer_mode IN ('inherit','none')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      created_by TEXT, updated_by TEXT, version BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE cc_sms_templates ADD COLUMN IF NOT EXISTS footer_text TEXT NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS cc_sms_audit (
      id BIGSERIAL PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
      resource_id TEXT, details JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

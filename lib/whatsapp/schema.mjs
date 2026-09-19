// Additive WhatsApp adapter storage. Work, ownership and capacity remain in
// ACD Core; these tables hold the connected WhatsApp Business Account and
// messaging profile, the number-to-queue map, the inbound staging archive with
// its media, thread identity per (business number, customer number) and
// per-message provider state.
export async function ensureWhatsAppSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_whatsapp_accounts (
      id TEXT PRIMARY KEY, waba_id TEXT, name TEXT NOT NULL DEFAULT '',
      credential_source TEXT NOT NULL DEFAULT 'primary',
      snapshot JSONB NOT NULL DEFAULT '{}', last_error TEXT,
      connected_at TIMESTAMPTZ NOT NULL DEFAULT now(), synced_at TIMESTAMPTZ,
      version BIGINT NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS cc_whatsapp_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      credential_source TEXT NOT NULL DEFAULT 'primary',
      webhook_url TEXT, webhook_failover_url TEXT, webhook_api_version TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      webhook_verified_at TIMESTAMPTZ, last_error TEXT,
      version BIGINT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_whatsapp_numbers (
      id UUID PRIMARY KEY, phone_number TEXT NOT NULL UNIQUE,
      phone_number_id TEXT, waba_id TEXT, display_name TEXT,
      messaging_profile_id TEXT REFERENCES cc_whatsapp_profiles(id),
      name TEXT NOT NULL, queue_id TEXT NOT NULL REFERENCES cc_queues(id),
      routing_enabled BOOLEAN NOT NULL DEFAULT false,
      sending_enabled BOOLEAN NOT NULL DEFAULT false,
      quality_rating TEXT, provider_status TEXT, last_error TEXT,
      version BIGINT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_whatsapp_received (
      number_id UUID NOT NULL REFERENCES cc_whatsapp_numbers(id),
      provider_message_id TEXT NOT NULL, customer_address TEXT NOT NULL,
      payload JSONB NOT NULL, classification TEXT NOT NULL DEFAULT 'customer',
      message_id UUID REFERENCES acd_messages(id),
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ,
      route_after TIMESTAMPTZ NOT NULL DEFAULT now(),
      media_state TEXT NOT NULL DEFAULT 'none' CHECK(media_state IN ('none','pending','ready','failed')),
      media_attempts INT NOT NULL DEFAULT 0, media_error TEXT,
      PRIMARY KEY(number_id,provider_message_id)
    );
    CREATE INDEX IF NOT EXISTS cc_whatsapp_received_pending ON cc_whatsapp_received(received_at) WHERE processed_at IS NULL;
    CREATE TABLE IF NOT EXISTS cc_whatsapp_media (
      number_id UUID NOT NULL, provider_message_id TEXT NOT NULL,
      kind TEXT NOT NULL, name TEXT NOT NULL, content_type TEXT NOT NULL,
      bytes BYTEA NOT NULL, byte_size INT NOT NULL, content_hash TEXT NOT NULL,
      caption TEXT, source_url TEXT, downloaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(number_id,provider_message_id),
      FOREIGN KEY(number_id,provider_message_id) REFERENCES cc_whatsapp_received(number_id,provider_message_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS cc_whatsapp_threads (
      conversation_id UUID PRIMARY KEY REFERENCES acd_conversations(id),
      number_id UUID NOT NULL REFERENCES cc_whatsapp_numbers(id),
      customer_address TEXT NOT NULL, customer_name TEXT,
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','waiting','completed')),
      last_inbound_at TIMESTAMPTZ, last_outbound_at TIMESTAMPTZ,
      UNIQUE(number_id,customer_address)
    );
    CREATE TABLE IF NOT EXISTS cc_whatsapp_messages (
      message_id UUID PRIMARY KEY REFERENCES acd_messages(id),
      number_id UUID NOT NULL REFERENCES cc_whatsapp_numbers(id),
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
      provider_message_id TEXT, wamid TEXT, status TEXT NOT NULL DEFAULT 'received',
      kind TEXT NOT NULL DEFAULT 'text', content JSONB NOT NULL DEFAULT '{}',
      error_code TEXT, error_detail TEXT, occurred_at TIMESTAMPTZ,
      saga_id UUID REFERENCES acd_sagas(id),
      next_delivery_sync_at TIMESTAMPTZ, delivery_sync_attempts INT NOT NULL DEFAULT 0,
      UNIQUE(number_id,provider_message_id)
    );
    CREATE INDEX IF NOT EXISTS cc_whatsapp_messages_delivery_sync ON cc_whatsapp_messages(next_delivery_sync_at) WHERE next_delivery_sync_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS cc_whatsapp_audit (
      id BIGSERIAL PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
      resource_id TEXT, details JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

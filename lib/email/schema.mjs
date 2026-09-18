// Additive email adapter storage; work, ownership and capacity remain in ACD Core.
export async function ensureEmailSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_email_mailboxes (
      id UUID PRIMARY KEY, provider_inbox_id TEXT NOT NULL UNIQUE,
      domain_id TEXT NOT NULL, address TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      queue_id TEXT NOT NULL REFERENCES cc_queues(id),
      routing_enabled BOOLEAN NOT NULL DEFAULT false,
      sending_enabled BOOLEAN NOT NULL DEFAULT false,
      sync_enabled BOOLEAN NOT NULL DEFAULT true,
      sync_cursor TEXT, next_sync_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_synced_at TIMESTAMPTZ, last_error TEXT,
      version BIGINT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_email_received (
      mailbox_id UUID NOT NULL REFERENCES cc_email_mailboxes(id),
      provider_message_id TEXT NOT NULL, payload JSONB NOT NULL,
      classification TEXT NOT NULL DEFAULT 'customer',
      message_id UUID REFERENCES acd_messages(id),
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ,
      PRIMARY KEY(mailbox_id,provider_message_id)
    );
    CREATE INDEX IF NOT EXISTS cc_email_received_pending ON cc_email_received(received_at) WHERE processed_at IS NULL;
    ALTER TABLE cc_email_received ADD COLUMN IF NOT EXISTS route_after TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE TABLE IF NOT EXISTS cc_email_threads (
      conversation_id UUID PRIMARY KEY REFERENCES acd_conversations(id),
      mailbox_id UUID NOT NULL REFERENCES cc_email_mailboxes(id),
      provider_thread_id TEXT NOT NULL, subject TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','waiting','completed')),
      UNIQUE(mailbox_id,provider_thread_id)
    );
    CREATE TABLE IF NOT EXISTS cc_email_messages (
      message_id UUID PRIMARY KEY REFERENCES acd_messages(id),
      mailbox_id UUID NOT NULL REFERENCES cc_email_mailboxes(id),
      provider_message_id TEXT, envelope JSONB NOT NULL, html_body TEXT NOT NULL DEFAULT '',
      rfc_message_id TEXT, in_reply_to TEXT, reference_ids JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'received', saga_id UUID REFERENCES acd_sagas(id),
      UNIQUE(mailbox_id,provider_message_id)
    );
    CREATE INDEX IF NOT EXISTS cc_email_rfc_message ON cc_email_messages(mailbox_id,rfc_message_id);
    ALTER TABLE cc_email_messages ADD COLUMN IF NOT EXISTS delivery_cursor TEXT;
    ALTER TABLE cc_email_messages ADD COLUMN IF NOT EXISTS next_delivery_sync_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE cc_email_messages ADD COLUMN IF NOT EXISTS delivery_error TEXT;
    CREATE TABLE IF NOT EXISTS cc_email_deliveries (
      message_id UUID NOT NULL REFERENCES cc_email_messages(message_id),
      recipient_id TEXT NOT NULL, kind TEXT, address TEXT, status TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL, evidence JSONB NOT NULL DEFAULT '{}',
      PRIMARY KEY(message_id,recipient_id)
    );
    CREATE TABLE IF NOT EXISTS cc_email_drafts (
      work_item_id UUID NOT NULL REFERENCES acd_work_items(id), agent_id TEXT NOT NULL REFERENCES users(id),
      content JSONB NOT NULL, version BIGINT NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(work_item_id,agent_id)
    );
    ALTER TABLE cc_email_drafts ADD COLUMN IF NOT EXISTS draft_id TEXT NOT NULL DEFAULT 'legacy';
    ALTER TABLE cc_email_drafts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE cc_email_drafts ADD COLUMN IF NOT EXISTS submitted_message_id UUID REFERENCES cc_email_messages(message_id);
    DO $$ BEGIN
      IF (SELECT count(*) FROM information_schema.key_column_usage
          WHERE table_schema=current_schema() AND table_name='cc_email_drafts' AND constraint_name='cc_email_drafts_pkey')=2 THEN
        ALTER TABLE cc_email_drafts DROP CONSTRAINT cc_email_drafts_pkey;
        ALTER TABLE cc_email_drafts ADD PRIMARY KEY(work_item_id,agent_id,draft_id);
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS cc_email_audit (
      id BIGSERIAL PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
      resource_id TEXT, details JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_email_compose_requests (
      command_id UUID PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES users(id),
      work_item_id UUID NOT NULL REFERENCES acd_work_items(id),request_hash TEXT NOT NULL
    );
  `);
}

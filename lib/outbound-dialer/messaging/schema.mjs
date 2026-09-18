// Additive messaging-campaign storage on the outbound attempt ledger. One ledger
// row is one message: the row itself is the send journal (state + lease), so no
// ACD saga, work item or acd_messages row is created per broadcast message.
// Shared by application upgrades and integration fixtures.
export const OUTBOUND_MESSAGE_STATES = Object.freeze([
  "pending", "rendered", "queued", "sending", "accepted", "sent", "delivered", "read", "replied",
  "throttled", "failed_transient", "failed_permanent", "undeliverable", "suppressed", "skipped", "unconfirmed", "cancelled",
]);

// Coarse ledger status kept in sync with the fine message state so the existing
// dashboard, history and completion queries work for messaging campaigns.
export const MESSAGE_STATE_LEDGER_STATUS = Object.freeze({
  pending: "claimed", rendered: "claimed", queued: "claimed", sending: "claimed",
  accepted: "dialing", sent: "dialing",
  delivered: "completed", read: "completed", unconfirmed: "completed", replied: "completed",
  throttled: "cancelled", failed_transient: "failed", failed_permanent: "failed", undeliverable: "failed",
  suppressed: "suppressed", skipped: "skipped", cancelled: "cancelled",
});
export const MESSAGE_TERMINAL_STATES = Object.freeze([
  "delivered", "read", "replied", "failed_permanent", "undeliverable", "suppressed", "skipped", "unconfirmed", "cancelled", "throttled", "failed_transient",
]);
export const MESSAGE_LIVE_STATES = Object.freeze(["pending", "rendered", "queued", "sending", "accepted", "sent"]);

const stateList = OUTBOUND_MESSAGE_STATES.map((state) => `'${state}'`).join(",");

export const OUTBOUND_MESSAGING_UPGRADE = `
  ALTER TABLE outbound_attempt_ledger ADD COLUMN IF NOT EXISTS message_state TEXT;
  ALTER TABLE outbound_attempt_ledger ADD COLUMN IF NOT EXISTS to_address TEXT;
  ALTER TABLE outbound_attempt_ledger ADD COLUMN IF NOT EXISTS sender_address TEXT;
  ALTER TABLE outbound_attempt_ledger ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
  ALTER TABLE outbound_attempt_ledger ADD COLUMN IF NOT EXISTS delivery_sync_at TIMESTAMPTZ;
  ALTER TABLE outbound_attempt_ledger ADD COLUMN IF NOT EXISTS delivery_sync_attempts INT NOT NULL DEFAULT 0;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='outbound_attempt_ledger'::regclass
      AND conname='outbound_attempt_ledger_message_state_check'
      AND position('unconfirmed' in pg_get_constraintdef(oid))>0
      AND position('throttled' in pg_get_constraintdef(oid))>0) THEN
      ALTER TABLE outbound_attempt_ledger DROP CONSTRAINT IF EXISTS outbound_attempt_ledger_message_state_check;
      ALTER TABLE outbound_attempt_ledger ADD CONSTRAINT outbound_attempt_ledger_message_state_check
        CHECK (message_state IS NULL OR message_state IN (${stateList}));
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='outbound_attempt_ledger'::regclass
      AND conname='outbound_attempt_ledger_channel_check' AND position('email' in pg_get_constraintdef(oid))=0) THEN
      ALTER TABLE outbound_attempt_ledger DROP CONSTRAINT outbound_attempt_ledger_channel_check;
      ALTER TABLE outbound_attempt_ledger ADD CONSTRAINT outbound_attempt_ledger_channel_check
        CHECK (channel IN ('voice', 'sms', 'whatsapp', 'email'));
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='outbound_campaigns'::regclass
      AND conname='outbound_campaigns_channel_check' AND position('email' in pg_get_constraintdef(oid))=0) THEN
      ALTER TABLE outbound_campaigns DROP CONSTRAINT outbound_campaigns_channel_check;
      ALTER TABLE outbound_campaigns ADD CONSTRAINT outbound_campaigns_channel_check
        CHECK (channel IN ('voice', 'sms', 'whatsapp', 'email'));
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='outbound_campaigns'::regclass
      AND conname='outbound_campaigns_mode_check' AND position('broadcast' in pg_get_constraintdef(oid))=0) THEN
      ALTER TABLE outbound_campaigns DROP CONSTRAINT outbound_campaigns_mode_check;
      ALTER TABLE outbound_campaigns ADD CONSTRAINT outbound_campaigns_mode_check
        CHECK (mode IN ('preview', 'progressive', 'agentless_ai', 'agentless_flow', 'power', 'predictive', 'broadcast'));
    END IF;
  END $$;
  CREATE INDEX IF NOT EXISTS idx_outbound_attempt_ledger_provider_message
    ON outbound_attempt_ledger (channel, provider_message_id) WHERE provider_message_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_outbound_attempt_ledger_message_state
    ON outbound_attempt_ledger (campaign_id, message_state) WHERE message_state IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_outbound_attempt_ledger_channel_created
    ON outbound_attempt_ledger (channel, created_at) WHERE message_state IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_outbound_attempt_ledger_delivery_sync
    ON outbound_attempt_ledger (delivery_sync_at) WHERE delivery_sync_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_outbound_attempt_ledger_to_address
    ON outbound_attempt_ledger (channel, to_address, created_at) WHERE to_address IS NOT NULL;
`;

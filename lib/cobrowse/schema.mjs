// Recording tables deliberately wait for F3, where a
// private object namespace and independently consented retention are required.
export async function ensureCobrowseSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS acd_cobrowse_pairings (
      id UUID PRIMARY KEY,
      widget_id UUID NOT NULL REFERENCES cc_widgets(id),
      widget_revision_id UUID NOT NULL REFERENCES cc_widget_revisions(id),
      origin TEXT NOT NULL,
      code_hmac TEXT NOT NULL,
      browser_secret_hash TEXT NOT NULL,
      admission_key TEXT NOT NULL DEFAULT 'unattributed',
      state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open','claimed','expired','cancelled')),
      attempts INT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
      expires_at TIMESTAMPTZ NOT NULL,
      claimed_work_item_id UUID REFERENCES acd_work_items(id),
      claimed_by TEXT,
      claimed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS acd_cobrowse_pairing_open_code
      ON acd_cobrowse_pairings(code_hmac) WHERE state = 'open';
    CREATE INDEX IF NOT EXISTS acd_cobrowse_pairing_expiry
      ON acd_cobrowse_pairings(expires_at) WHERE state = 'open';
    CREATE INDEX IF NOT EXISTS acd_cobrowse_pairing_browser
      ON acd_cobrowse_pairings(browser_secret_hash, state);
    CREATE INDEX IF NOT EXISTS acd_cobrowse_pairing_admission
      ON acd_cobrowse_pairings(admission_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS acd_cobrowse_sessions (
      id UUID PRIMARY KEY,
      work_item_id UUID NOT NULL REFERENCES acd_work_items(id) ON DELETE CASCADE,
      pairing_id UUID REFERENCES acd_cobrowse_pairings(id),
      widget_id UUID NOT NULL REFERENCES cc_widgets(id),
      widget_revision_id UUID NOT NULL REFERENCES cc_widget_revisions(id),
      widget_session_id UUID REFERENCES cc_widget_sessions(id),
      origin TEXT NOT NULL,
      browser_secret_hash TEXT NOT NULL,
      previous_browser_secret_hash TEXT,
      previous_secret_expires_at TIMESTAMPTZ,
      agent_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN
        ('requested','pending_consent','connecting','active','paused','reconnecting','ended','failed')),
      control_level TEXT NOT NULL DEFAULT 'observe' CHECK (control_level IN ('observe','assist')),
      control_requested_at TIMESTAMPTZ,
      control_granted_at TIMESTAMPTZ,
      auth_generation BIGINT NOT NULL DEFAULT 1,
      consent_granted_at TIMESTAMPTZ,
      consent_policy_version TEXT,
      consent_text_hash TEXT,
      page_epoch TEXT,
      started_at TIMESTAMPTZ,
      reconnect_deadline_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      end_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE acd_cobrowse_sessions ADD COLUMN IF NOT EXISTS previous_browser_secret_hash TEXT;
    ALTER TABLE acd_cobrowse_sessions ADD COLUMN IF NOT EXISTS previous_secret_expires_at TIMESTAMPTZ;
    ALTER TABLE acd_cobrowse_sessions ADD COLUMN IF NOT EXISTS reconnect_deadline_at TIMESTAMPTZ;
    ALTER TABLE acd_cobrowse_sessions ADD COLUMN IF NOT EXISTS control_requested_at TIMESTAMPTZ;
    ALTER TABLE acd_cobrowse_sessions ADD COLUMN IF NOT EXISTS control_granted_at TIMESTAMPTZ;
    ALTER TABLE acd_cobrowse_sessions DROP CONSTRAINT IF EXISTS acd_cobrowse_sessions_control_level_check;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='acd_cobrowse_control_level_policy') THEN
        ALTER TABLE acd_cobrowse_sessions ADD CONSTRAINT acd_cobrowse_control_level_policy
          CHECK (control_level IN ('observe','assist'));
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS acd_cobrowse_one_live_work
      ON acd_cobrowse_sessions(work_item_id)
      WHERE state NOT IN ('ended','failed');
    CREATE INDEX IF NOT EXISTS acd_cobrowse_session_work_created
      ON acd_cobrowse_sessions(work_item_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS acd_cobrowse_session_widget_session
      ON acd_cobrowse_sessions(widget_session_id)
      WHERE widget_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS acd_cobrowse_session_pairing
      ON acd_cobrowse_sessions(pairing_id)
      WHERE pairing_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS acd_cobrowse_tickets (
      token_hash TEXT PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES acd_cobrowse_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('publisher','viewer')),
      actor_id TEXT,
      origin TEXT NOT NULL,
      auth_generation BIGINT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS acd_cobrowse_ticket_expiry
      ON acd_cobrowse_tickets(expires_at);
    CREATE INDEX IF NOT EXISTS acd_cobrowse_ticket_session
      ON acd_cobrowse_tickets(session_id);

    CREATE TABLE IF NOT EXISTS acd_cobrowse_claim_attempts (
      id BIGSERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS acd_cobrowse_claim_agent_time
      ON acd_cobrowse_claim_attempts(agent_id, attempted_at DESC);
  `);
}

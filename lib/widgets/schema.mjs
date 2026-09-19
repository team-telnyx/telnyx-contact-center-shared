export async function ensureWidgetSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_widget_handoff_integration (
      singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
      installation_id UUID NOT NULL,
      tool_id TEXT,
      tool_name TEXT,
      secret_identifier TEXT,
      creation_state TEXT NOT NULL DEFAULT 'new',
      lease_id UUID,
      lease_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_widgets (
      id UUID PRIMARY KEY,
      public_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      normalized_name TEXT UNIQUE NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      published_revision_id UUID,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_widget_revisions (
      id UUID PRIMARY KEY,
      widget_id UUID NOT NULL REFERENCES cc_widgets(id),
      version INT NOT NULL,
      edit_version BIGINT NOT NULL DEFAULT 1,
      state TEXT NOT NULL CHECK(state IN ('draft','published','archived')),
      config JSONB NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ,
      UNIQUE(widget_id,version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cc_widget_one_draft ON cc_widget_revisions(widget_id) WHERE state='draft';
    CREATE UNIQUE INDEX IF NOT EXISTS cc_widget_one_published ON cc_widget_revisions(widget_id) WHERE state='published';
    CREATE TABLE IF NOT EXISTS cc_widget_audit (
      id BIGSERIAL PRIMARY KEY,
      widget_id UUID NOT NULL REFERENCES cc_widgets(id),
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_widget_preview_assets (
      widget_id UUID NOT NULL REFERENCES cc_widgets(id),
      variant TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(widget_id,variant)
    );
    CREATE TABLE IF NOT EXISTS cc_widget_sessions (
      id UUID PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      widget_id UUID NOT NULL REFERENCES cc_widgets(id),
      revision_id UUID NOT NULL REFERENCES cc_widget_revisions(id),
      conversation_id UUID NOT NULL REFERENCES acd_conversations(id),
      origin TEXT NOT NULL,
      client_key TEXT NOT NULL,
      typing_until TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(widget_id,origin,client_key)
    );
    ALTER TABLE cc_widget_sessions ADD COLUMN IF NOT EXISTS runtime_kind TEXT NOT NULL DEFAULT 'human';
    ALTER TABLE cc_widget_sessions ADD COLUMN IF NOT EXISTS assistant_id TEXT;
    ALTER TABLE cc_widget_sessions ADD COLUMN IF NOT EXISTS provider_conversation_id TEXT;
    ALTER TABLE cc_widget_sessions ADD COLUMN IF NOT EXISTS context JSONB NOT NULL DEFAULT '{}';
    ALTER TABLE cc_widget_sessions ADD COLUMN IF NOT EXISTS runtime_state TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE cc_widget_sessions ADD COLUMN IF NOT EXISTS greeting TEXT NOT NULL DEFAULT '';
    ALTER TABLE cc_widget_sessions ADD COLUMN IF NOT EXISTS admission_key TEXT NOT NULL DEFAULT 'unattributed';
    CREATE INDEX IF NOT EXISTS cc_widget_session_admission ON cc_widget_sessions(widget_id,admission_key,created_at);
    CREATE INDEX IF NOT EXISTS cc_widget_session_created ON cc_widget_sessions(widget_id,created_at);
    CREATE TABLE IF NOT EXISTS cc_widget_handoffs (
      session_id UUID PRIMARY KEY REFERENCES cc_widget_sessions(id),
      work_item_id UUID REFERENCES acd_work_items(id),
      queue_id TEXT,
      queue_name TEXT,
      status TEXT NOT NULL CHECK(status IN ('waiting','failed')),
      reason TEXT NOT NULL,
      summary TEXT NOT NULL,
      intent TEXT NOT NULL DEFAULT '',
      sentiment TEXT NOT NULL DEFAULT 'unknown',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_widget_ai_commands (
      session_id UUID NOT NULL REFERENCES cc_widget_sessions(id),
      client_id TEXT NOT NULL,
      content TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('processing','completed','unknown','rejected')),
      reply TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(session_id,client_id)
    );
    CREATE TABLE IF NOT EXISTS cc_attachment_uploads (
      id UUID PRIMARY KEY,
      conversation_id UUID NOT NULL REFERENCES acd_conversations(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS cc_attachment_upload_admission ON cc_attachment_uploads(conversation_id,created_at);
    CREATE TABLE IF NOT EXISTS acd_text_attachments (
      id UUID PRIMARY KEY,
      message_id UUID NOT NULL REFERENCES acd_messages(id),
      conversation_id UUID NOT NULL REFERENCES acd_conversations(id),
      name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      byte_size INT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    DROP INDEX IF EXISTS acd_one_attachment_per_message;
    CREATE INDEX IF NOT EXISTS acd_attachments_per_message ON acd_text_attachments(message_id);
  `);
}

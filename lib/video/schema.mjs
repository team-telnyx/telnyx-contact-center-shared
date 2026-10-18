// Video channel storage: one Telnyx Video Rooms room per work item. Routing,
// offers and wrap-up stay in ACD Core; this table only tracks the provider
// room, its participants and the recording artefacts until they land in
// acd_recordings (the internal documentation).
export async function ensureVideoSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS acd_video_sessions (
      work_item_id       UUID PRIMARY KEY REFERENCES acd_work_items(id) ON DELETE CASCADE,
      conversation_id    UUID NOT NULL REFERENCES acd_conversations(id),
      provider           TEXT NOT NULL DEFAULT 'telnyx',
      room_id            TEXT,
      room_session_id    TEXT,
      state              TEXT NOT NULL DEFAULT 'starting'
                         CHECK (state IN ('starting','waiting','active','ended','failed')),
      recording_enabled  BOOLEAN NOT NULL DEFAULT true,
      recording_layout   TEXT NOT NULL DEFAULT 'pip' CHECK (recording_layout IN ('pip','split')),
      media              JSONB NOT NULL DEFAULT '{}'::jsonb,
      participants       JSONB NOT NULL DEFAULT '[]'::jsonb,
      recordings         JSONB NOT NULL DEFAULT '[]'::jsonb,
      composition_id     TEXT,
      composition_state  TEXT,
      composition_error  TEXT,
      started_at         TIMESTAMPTZ,
      ended_at           TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE acd_video_sessions ADD COLUMN IF NOT EXISTS supervision JSONB;
    -- A room can precede its first human work item. The stable session ID also
    -- survives handoff and queue/agent transfers.
    ALTER TABLE acd_video_sessions ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid() NOT NULL;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='acd_video_sessions'::regclass AND contype='p'
        AND pg_get_constraintdef(oid)='PRIMARY KEY (work_item_id)') THEN
        ALTER TABLE acd_video_sessions DROP CONSTRAINT acd_video_sessions_pkey;
        ALTER TABLE acd_video_sessions ALTER COLUMN work_item_id DROP NOT NULL;
        ALTER TABLE acd_video_sessions ADD PRIMARY KEY (id);
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS acd_video_session_work ON acd_video_sessions(work_item_id);
    CREATE UNIQUE INDEX IF NOT EXISTS acd_video_session_id ON acd_video_sessions(id);
    ALTER TABLE acd_video_sessions ADD COLUMN IF NOT EXISTS conference_config JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE acd_video_sessions ADD COLUMN IF NOT EXISTS artifacts JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE acd_video_sessions ADD COLUMN IF NOT EXISTS composition_local_attempts INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS cc_video_ai_profiles (
      id UUID PRIMARY KEY, widget_id UUID NOT NULL, revision_id UUID NOT NULL,
      source_assistant_id TEXT NOT NULL, assistant_id TEXT NOT NULL UNIQUE,
      source_hash TEXT NOT NULL, config JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ,
      UNIQUE(revision_id,source_assistant_id)
    );
    CREATE TABLE IF NOT EXISTS cc_video_ai_sessions (
      video_session_id UUID PRIMARY KEY REFERENCES acd_video_sessions(id) ON DELETE CASCADE,
      profile_id UUID NOT NULL REFERENCES cc_video_ai_profiles(id),
      desired_state TEXT NOT NULL DEFAULT 'active' CHECK(desired_state IN ('active','muted','stopped')),
      state TEXT NOT NULL DEFAULT 'pending', generation BIGINT NOT NULL DEFAULT 0,
      lease_owner TEXT, lease_until TIMESTAMPTZ, provider_conversation_id TEXT,
      vision JSONB NOT NULL DEFAULT '{}'::jsonb, sources JSONB NOT NULL DEFAULT '[]'::jsonb,
      error TEXT, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE cc_video_ai_profiles ADD COLUMN IF NOT EXISTS source_name TEXT;
    CREATE TABLE IF NOT EXISTS cc_video_members (
      id UUID PRIMARY KEY, video_session_id UUID NOT NULL REFERENCES acd_video_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('customer','agent','ai')), principal_id TEXT NOT NULL,
      binding_hash TEXT NOT NULL, participant_id TEXT, generation BIGINT NOT NULL DEFAULT 1,
      consent JSONB NOT NULL DEFAULT '{}'::jsonb, revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cc_video_members_bound ON cc_video_members(video_session_id,role,principal_id) WHERE revoked_at IS NULL AND participant_id IS NOT NULL;
    DROP INDEX IF EXISTS cc_video_members_current;
    CREATE TABLE IF NOT EXISTS cc_video_ai_events (
      id BIGSERIAL PRIMARY KEY, video_session_id UUID NOT NULL REFERENCES acd_video_sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_video_ai_commands (
      id UUID PRIMARY KEY, video_session_id UUID NOT NULL REFERENCES acd_video_sessions(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL, kind TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '30 seconds', completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_video_ai_workers (
      id TEXT PRIMARY KEY, capacity INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0,
      heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE cc_video_ai_workers ADD COLUMN IF NOT EXISTS control_url TEXT;
    ALTER TABLE cc_video_ai_workers ADD COLUMN IF NOT EXISTS control_token TEXT;
    CREATE INDEX IF NOT EXISTS acd_video_session_room ON acd_video_sessions(room_id) WHERE room_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS acd_video_session_composition ON acd_video_sessions(composition_id) WHERE composition_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS acd_video_session_conversation ON acd_video_sessions(conversation_id);
    -- Uploaded files for the widget's waiting playlist; bytes live in the
    -- storage driver (local disk, S3 or Azure), served by /api/video/media/[id].
    CREATE TABLE IF NOT EXISTS cc_video_media (
      id            UUID PRIMARY KEY,
      name          TEXT NOT NULL,
      content_type  TEXT NOT NULL,
      byte_size     BIGINT NOT NULL,
      storage_key   TEXT NOT NULL,
      created_by    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at    TIMESTAMPTZ
    );
  `);
}

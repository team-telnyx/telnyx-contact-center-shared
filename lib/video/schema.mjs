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

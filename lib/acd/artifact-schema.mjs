// Native ACD Core history artifacts and business-object links.

export async function ensureAcdArtifactSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS acd_recordings (
      id                    UUID PRIMARY KEY,
      work_item_id          UUID NOT NULL REFERENCES acd_work_items(id) ON DELETE CASCADE,
      leg_id                UUID REFERENCES acd_legs(id) ON DELETE SET NULL,
      provider              TEXT NOT NULL DEFAULT 'telnyx',
      provider_recording_id TEXT,
      source_event_id       TEXT NOT NULL UNIQUE,
      provider_call_id      TEXT,
      provider_session_id   TEXT,
      format                TEXT,
      channels              JSONB,
      recording_url         TEXT,
      recording_urls        JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at            TIMESTAMPTZ,
      ended_at              TIMESTAMPTZ,
      provider_metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS acd_recording_provider_id
      ON acd_recordings (provider, provider_recording_id)
      WHERE provider_recording_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS acd_recording_work_item
      ON acd_recordings (work_item_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS acd_recording_session
      ON acd_recordings (provider_session_id)
      WHERE provider_session_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS acd_transcripts (
      id                     UUID PRIMARY KEY,
      work_item_id           UUID NOT NULL REFERENCES acd_work_items(id) ON DELETE CASCADE,
      leg_id                 UUID REFERENCES acd_legs(id) ON DELETE SET NULL,
      recording_id           UUID REFERENCES acd_recordings(id) ON DELETE SET NULL,
      provider               TEXT NOT NULL DEFAULT 'telnyx',
      provider_transcript_id TEXT,
      source_event_id        TEXT NOT NULL UNIQUE,
      provider_call_id       TEXT,
      provider_session_id    TEXT,
      source                 TEXT NOT NULL,
      track                  TEXT,
      language               TEXT,
      model                  TEXT,
      text                   TEXT NOT NULL,
      segments               JSONB NOT NULL DEFAULT '[]'::jsonb,
      speaker_turns          JSONB NOT NULL DEFAULT '[]'::jsonb,
      summary                TEXT,
      occurred_at            TIMESTAMPTZ,
      provider_metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS acd_transcript_provider_id
      ON acd_transcripts (provider, provider_transcript_id)
      WHERE provider_transcript_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS acd_transcript_work_item
      ON acd_transcripts (work_item_id, occurred_at, created_at);
    CREATE INDEX IF NOT EXISTS acd_transcript_recording
      ON acd_transcripts (recording_id)
      WHERE recording_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS acd_work_item_annotations (
      work_item_id UUID PRIMARY KEY REFERENCES acd_work_items(id) ON DELETE CASCADE,
      notes        TEXT,
      tags         JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by   TEXT,
      updated_by   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // These tables belong to optional product modules and are absent from the
  // minimal ACD test schema. ALTER TABLE IF EXISTS keeps Core bootstrap usable
  // in both environments.
  await db.query(`
    ALTER TABLE IF EXISTS form_submissions
      ADD COLUMN IF NOT EXISTS work_item_id UUID;
    ALTER TABLE IF EXISTS aa_workflow_sessions
      ADD COLUMN IF NOT EXISTS work_item_id UUID;
    ALTER TABLE IF EXISTS aa_workflow_sessions
      ADD COLUMN IF NOT EXISTS transcriptions JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE IF EXISTS aa_workflow_sessions
      ADD COLUMN IF NOT EXISTS suggestions JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE IF EXISTS aa_ai_handoff_events
      ADD COLUMN IF NOT EXISTS work_item_id UUID;
    ALTER TABLE IF EXISTS quality_evaluations
      ADD COLUMN IF NOT EXISTS work_item_id UUID;
    ALTER TABLE IF EXISTS quality_ai_jobs
      ADD COLUMN IF NOT EXISTS work_item_id UUID;

    ALTER TABLE IF EXISTS acd_action_requests
      ALTER COLUMN saga_id DROP NOT NULL;
    ALTER TABLE IF EXISTS acd_action_requests
      ADD COLUMN IF NOT EXISTS leg_id UUID REFERENCES acd_legs(id) ON DELETE SET NULL;
    ALTER TABLE IF EXISTS acd_action_requests
      ADD COLUMN IF NOT EXISTS event_id BIGINT REFERENCES acd_events(id) ON DELETE SET NULL;

  `);

  await db.query(`
    DO $acd_artifact_links$
    BEGIN
      IF to_regclass('public.form_submissions') IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'form_submissions_work_item_fk') THEN
          ALTER TABLE form_submissions ADD CONSTRAINT form_submissions_work_item_fk
            FOREIGN KEY (work_item_id) REFERENCES acd_work_items(id) ON DELETE SET NULL;
        END IF;
        CREATE INDEX IF NOT EXISTS idx_form_submissions_work_item_id
          ON form_submissions (work_item_id);
      END IF;

      IF to_regclass('public.aa_workflow_sessions') IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'aa_workflow_sessions_work_item_fk') THEN
          ALTER TABLE aa_workflow_sessions ADD CONSTRAINT aa_workflow_sessions_work_item_fk
            FOREIGN KEY (work_item_id) REFERENCES acd_work_items(id) ON DELETE CASCADE;
        END IF;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_aa_workflow_sessions_work_item_id
          ON aa_workflow_sessions (work_item_id) WHERE work_item_id IS NOT NULL;
      END IF;

      IF to_regclass('public.aa_ai_handoff_events') IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'aa_ai_handoff_events_work_item_fk') THEN
          ALTER TABLE aa_ai_handoff_events ADD CONSTRAINT aa_ai_handoff_events_work_item_fk
            FOREIGN KEY (work_item_id) REFERENCES acd_work_items(id) ON DELETE CASCADE;
        END IF;
        CREATE INDEX IF NOT EXISTS idx_aa_ai_handoff_events_work_item_id
          ON aa_ai_handoff_events (work_item_id);
      END IF;

      IF to_regclass('public.quality_evaluations') IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quality_evaluations_work_item_fk') THEN
          ALTER TABLE quality_evaluations ADD CONSTRAINT quality_evaluations_work_item_fk
            FOREIGN KEY (work_item_id) REFERENCES acd_work_items(id) ON DELETE CASCADE;
        END IF;
        CREATE INDEX IF NOT EXISTS idx_quality_evaluations_work_item_id
          ON quality_evaluations (work_item_id);
      END IF;

      IF to_regclass('public.quality_ai_jobs') IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quality_ai_jobs_work_item_fk') THEN
          ALTER TABLE quality_ai_jobs ADD CONSTRAINT quality_ai_jobs_work_item_fk
            FOREIGN KEY (work_item_id) REFERENCES acd_work_items(id) ON DELETE CASCADE;
        END IF;
        CREATE INDEX IF NOT EXISTS idx_quality_ai_jobs_work_item_id
          ON quality_ai_jobs (work_item_id);
      END IF;
    END
    $acd_artifact_links$;
  `);

  await db.query(`
    ALTER TABLE IF EXISTS form_submissions
      DROP COLUMN IF EXISTS interaction_id;
    ALTER TABLE IF EXISTS form_submissions
      ALTER COLUMN work_item_id SET NOT NULL;
    ALTER TABLE IF EXISTS aa_workflow_sessions
      DROP COLUMN IF EXISTS interaction_id;
    ALTER TABLE IF EXISTS aa_workflow_sessions
      ALTER COLUMN work_item_id SET NOT NULL;
    ALTER TABLE IF EXISTS aa_ai_handoff_events
      DROP COLUMN IF EXISTS interaction_id;
    ALTER TABLE IF EXISTS aa_ai_handoff_events
      ALTER COLUMN work_item_id SET NOT NULL;
    ALTER TABLE IF EXISTS quality_evaluations
      DROP COLUMN IF EXISTS interaction_id;
    ALTER TABLE IF EXISTS quality_evaluations
      ALTER COLUMN work_item_id SET NOT NULL;
    ALTER TABLE IF EXISTS quality_ai_jobs
      DROP COLUMN IF EXISTS interaction_id;
    ALTER TABLE IF EXISTS quality_ai_jobs
      ALTER COLUMN work_item_id SET NOT NULL;
  `);
}

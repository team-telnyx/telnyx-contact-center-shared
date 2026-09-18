import { randomUUID } from "node:crypto";
import { appendEvent } from "./events.mjs";
import { isUtteranceFinal } from "../agent-assist/transcription-turns.mjs";

export const ACD_ARTIFACT_EVENT_TYPES = new Set([
  "call.recording.saved",
  "call.recording.transcription.saved",
  "call.transcription",
]);

export async function updateWorkItemAgentLanguage(db, workItemId, language) {
  if (!db || !workItemId || !language) return false;
  const result = await db.query(
    `UPDATE acd_work_items
        SET attributes = attributes || jsonb_build_object('agent_language', $2::text),
            version = version + 1
      WHERE id = $1
      RETURNING id`,
    [workItemId, language],
  );
  return result.rowCount > 0;
}

function eventTime(event) {
  const value = event?.occurredAt || event?.payload?.occurred_at || null;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function recordingUrl(payload) {
  return firstString(
    payload?.recording_urls?.mp3,
    payload?.recording_urls?.wav,
    payload?.recording_urls?.public_recording_urls?.[0],
    payload?.recording_urls?.recording_urls?.[0],
    payload?.public_recording_urls?.[0],
    payload?.recording_url,
  );
}

/**
 * Resolve artifact ownership conservatively. A provider call-control id is an
 * exact leg key. A session fallback is accepted only when every matching leg
 * belongs to one work item; conferences can legitimately contain many legs.
 */
export async function resolveAcdArtifactContext(db, payload = {}) {
  const callControlId = firstString(payload.call_control_id);
  if (callControlId) {
    const exact = await db.query(
      `SELECT l.id AS leg_id, l.work_item_id, l.provider_call_id,
              l.provider_session_id, l.role
         FROM acd_legs l
        WHERE l.provider_call_id = $1
        LIMIT 2`,
      [callControlId],
    );
    if (exact.rowCount === 1) return exact.rows[0];
  }

  const providerSessionId = firstString(payload.call_session_id);
  if (!providerSessionId) return null;
  const session = await db.query(
    `SELECT l.work_item_id,
            (array_agg(l.id ORDER BY
              CASE WHEN l.provider_call_id = $2 THEN 0 ELSE 1 END,
              l.created_at DESC))[1] AS leg_id,
            (array_agg(l.provider_call_id ORDER BY
              CASE WHEN l.provider_call_id = $2 THEN 0 ELSE 1 END,
              l.created_at DESC))[1] AS provider_call_id,
            $1::text AS provider_session_id,
            COUNT(DISTINCT l.work_item_id)::int AS work_item_count
       FROM acd_legs l
      WHERE l.provider_session_id = $1
      GROUP BY l.work_item_id`,
    [providerSessionId, callControlId],
  );
  if (session.rowCount !== 1 || session.rows[0].work_item_count !== 1) return null;
  return session.rows[0];
}

async function artifactEventAlreadyRecorded(db, eventId) {
  const result = await db.query(
    `SELECT 1 FROM acd_events
      WHERE type IN ('recording_saved', 'transcript_saved')
        AND payload->>'source_event_id' = $1
      LIMIT 1`,
    [eventId],
  );
  return result.rowCount > 0;
}

async function persistRecording(db, event, context) {
  const payload = event.payload || {};
  const provider = event.provider || "telnyx";
  const providerRecordingId = firstString(payload.recording_id, payload.id);
  const existing = (
    await db.query(
      `SELECT * FROM acd_recordings
        WHERE source_event_id = $1
           OR ($2::text IS NOT NULL AND provider = $3 AND provider_recording_id = $2)
        ORDER BY (source_event_id = $1) DESC
        LIMIT 1
        FOR UPDATE`,
      [event.eventId, providerRecordingId, provider],
    )
  ).rows[0];
  const id = existing?.id || randomUUID();
  const urls = payload.recording_urls || payload.public_recording_urls || {};
  const saved = (
    await db.query(
      `INSERT INTO acd_recordings
         (id, work_item_id, leg_id, provider, provider_recording_id,
          source_event_id, provider_call_id, provider_session_id, format,
          channels, recording_url, recording_urls, started_at, ended_at,
          provider_metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$15::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         leg_id = COALESCE(acd_recordings.leg_id, EXCLUDED.leg_id),
         provider_recording_id = COALESCE(acd_recordings.provider_recording_id, EXCLUDED.provider_recording_id),
         provider_call_id = COALESCE(acd_recordings.provider_call_id, EXCLUDED.provider_call_id),
         provider_session_id = COALESCE(acd_recordings.provider_session_id, EXCLUDED.provider_session_id),
         format = COALESCE(EXCLUDED.format, acd_recordings.format),
         channels = COALESCE(EXCLUDED.channels, acd_recordings.channels),
         recording_url = COALESCE(EXCLUDED.recording_url, acd_recordings.recording_url),
         recording_urls = CASE WHEN EXCLUDED.recording_urls = '{}'::jsonb THEN acd_recordings.recording_urls ELSE EXCLUDED.recording_urls END,
         started_at = COALESCE(EXCLUDED.started_at, acd_recordings.started_at),
         ended_at = COALESCE(EXCLUDED.ended_at, acd_recordings.ended_at),
         provider_metadata = acd_recordings.provider_metadata || EXCLUDED.provider_metadata,
         updated_at = now()
       RETURNING *`,
      [
        id,
        context.work_item_id,
        context.leg_id,
        provider,
        providerRecordingId,
        existing?.source_event_id || event.eventId,
        firstString(payload.call_control_id, context.provider_call_id),
        firstString(payload.call_session_id, context.provider_session_id),
        firstString(payload.format),
        payload.channels == null ? null : JSON.stringify(payload.channels),
        recordingUrl(payload),
        JSON.stringify(urls),
        payload.recording_started_at || null,
        payload.recording_ended_at || eventTime(event),
        JSON.stringify(payload),
      ],
    )
  ).rows[0];

  if (!(await artifactEventAlreadyRecorded(db, event.eventId))) {
    await appendEvent(db, {
      workItemId: context.work_item_id,
      type: "recording_saved",
      actor: `provider:${provider}`,
      payload: {
        recording_id: saved.id,
        provider_recording_id: saved.provider_recording_id,
        leg_id: context.leg_id,
        source_event_id: event.eventId,
      },
    });
  }
  return saved;
}

function transcriptPayload(event) {
  const payload = event.payload || {};
  if (event.eventType === "call.transcription") {
    const data = payload.transcription_data || {};
    if (!isUtteranceFinal(data)) return null;
    const text = firstString(data.transcript);
    if (!text) return null;
    return {
      text,
      source: "live",
      track: firstString(data.transcription_track),
      language: firstString(data.language, data.detected_language),
      model: firstString(data.model),
      providerTranscriptId: firstString(data.transcription_id, data.id),
      segments: data.segments || [],
      speakerTurns: data.speaker_turns || [],
      summary: firstString(data.summary),
      metadata: data,
    };
  }
  const text = firstString(payload.transcription_text, payload.transcript);
  if (!text) return null;
  return {
    text,
    source: "recording",
    track: firstString(payload.transcription_track),
    language: firstString(payload.language),
    model: firstString(payload.model, payload.transcription_engine),
    providerTranscriptId: firstString(payload.transcription_id, payload.id),
    segments: payload.segments || [],
    speakerTurns: payload.speaker_turns || [],
    summary: firstString(payload.transcription_summary, payload.summary),
    metadata: payload,
  };
}

async function persistTranscript(db, event, context) {
  const normalized = transcriptPayload(event);
  if (!normalized) return null;
  const provider = event.provider || "telnyx";
  const providerRecordingId = firstString(event.payload?.recording_id);
  const recording = providerRecordingId
    ? (
        await db.query(
          `SELECT id FROM acd_recordings
            WHERE provider = $1 AND provider_recording_id = $2
            LIMIT 1`,
          [provider, providerRecordingId],
        )
      ).rows[0]
    : null;
  const existing = (
    await db.query(
      `SELECT * FROM acd_transcripts
        WHERE source_event_id = $1
           OR ($2::text IS NOT NULL AND provider = $3 AND provider_transcript_id = $2)
        ORDER BY (source_event_id = $1) DESC
        LIMIT 1
        FOR UPDATE`,
      [event.eventId, normalized.providerTranscriptId, provider],
    )
  ).rows[0];
  const id = existing?.id || randomUUID();
  const saved = (
    await db.query(
      `INSERT INTO acd_transcripts
         (id, work_item_id, leg_id, recording_id, provider,
          provider_transcript_id, source_event_id, provider_call_id,
          provider_session_id, source, track, language, model, text, segments,
          speaker_turns, summary, occurred_at, provider_metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,$19::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         recording_id = COALESCE(EXCLUDED.recording_id, acd_transcripts.recording_id),
         leg_id = COALESCE(acd_transcripts.leg_id, EXCLUDED.leg_id),
         text = EXCLUDED.text,
         segments = EXCLUDED.segments,
         speaker_turns = EXCLUDED.speaker_turns,
         summary = EXCLUDED.summary,
         language = COALESCE(EXCLUDED.language, acd_transcripts.language),
         model = COALESCE(EXCLUDED.model, acd_transcripts.model),
         provider_metadata = acd_transcripts.provider_metadata || EXCLUDED.provider_metadata,
         updated_at = now()
       RETURNING *`,
      [
        id,
        context.work_item_id,
        context.leg_id,
        recording?.id || null,
        provider,
        normalized.providerTranscriptId,
        existing?.source_event_id || event.eventId,
        firstString(event.payload?.call_control_id, context.provider_call_id),
        firstString(event.payload?.call_session_id, context.provider_session_id),
        normalized.source,
        normalized.track,
        normalized.language,
        normalized.model,
        normalized.text,
        JSON.stringify(normalized.segments),
        JSON.stringify(normalized.speakerTurns),
        normalized.summary,
        eventTime(event),
        JSON.stringify(normalized.metadata),
      ],
    )
  ).rows[0];

  if (!(await artifactEventAlreadyRecorded(db, event.eventId))) {
    await appendEvent(db, {
      workItemId: context.work_item_id,
      type: "transcript_saved",
      actor: `provider:${provider}`,
      payload: {
        transcript_id: saved.id,
        recording_id: saved.recording_id,
        leg_id: context.leg_id,
        source: saved.source,
        track: saved.track,
        source_event_id: event.eventId,
      },
    });
  }
  return saved;
}

/** Persist one native artifact from a leased Core webhook row. */
export async function applyAcdArtifactEvent(pool, event) {
  if (!ACD_ARTIFACT_EVENT_TYPES.has(event?.eventType)) return { handled: false };
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const context = await resolveAcdArtifactContext(db, event.payload || {});
    if (!context) {
      await db.query("ROLLBACK");
      return { handled: true, outcome: "unmatched" };
    }
    let artifact = null;
    if (event.eventType === "call.recording.saved") {
      artifact = await persistRecording(db, event, context);
    } else {
      artifact = await persistTranscript(db, event, context);
    }
    await db.query("COMMIT");
    return {
      handled: true,
      outcome: artifact ? "applied" : "noop",
      workItemId: context.work_item_id,
      artifactId: artifact?.id || null,
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

export async function upsertWorkItemAnnotation(db, {
  workItemId,
  notes = null,
  tags = [],
  actorId = null,
}) {
  if (!workItemId) throw new TypeError("workItemId is required");
  if (!Array.isArray(tags)) throw new TypeError("tags must be an array");
  const result = await db.query(
    `INSERT INTO acd_work_item_annotations
       (work_item_id, notes, tags, created_by, updated_by)
     VALUES ($1,$2,$3::jsonb,$4,$4)
     ON CONFLICT (work_item_id) DO UPDATE SET
       notes = EXCLUDED.notes,
       tags = EXCLUDED.tags,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [workItemId, notes, JSON.stringify(tags), actorId],
  );
  return result.rows[0];
}

export async function persistGeneratedTranscript(pool, {
  workItemId,
  providerRecordingId = null,
  text,
  segments = [],
  speakerTurns = [],
  summary = null,
  language = null,
  model = null,
  sourceEventId,
  metadata = {},
}) {
  if (!workItemId || !text || !sourceEventId) {
    throw new TypeError("workItemId, text and sourceEventId are required");
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const artifact = await persistTranscript(
      db,
      {
        eventId: sourceEventId,
        eventType: "call.recording.transcription.saved",
        provider: "telnyx",
        occurredAt: new Date().toISOString(),
        payload: {
          recording_id: providerRecordingId,
          transcription_text: text,
          segments,
          speaker_turns: speakerTurns,
          transcription_summary: summary,
          language,
          model,
          ...metadata,
        },
      },
      { work_item_id: workItemId, leg_id: null },
    );
    await db.query("COMMIT");
    return artifact;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

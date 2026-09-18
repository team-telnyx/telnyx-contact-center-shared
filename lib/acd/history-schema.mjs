// Read-only compatibility surface for voice screens while their presentation
// models move to the versioned ACD history DTO. Every value is derived from
// Core state; the view never reads or joins the retired interaction runtime.

export async function ensureAcdHistorySchema(db) {
  await db.query(`
    CREATE OR REPLACE VIEW acd_history_interactions AS
    SELECT
      w.id,
      w.id AS work_item_id,
      w.channel AS interaction_type,
      w.queue_id,
      q.name AS queue_name,
      CASE WHEN w.state = 'offered' THEN COALESCE(live_offer.agent_id, agent_segment.agent_id) ELSE COALESCE(agent_segment.agent_id, live_offer.agent_id) END AS agent_id,
      CASE WHEN w.state = 'offered' THEN COALESCE(live_offer.username, agent_segment.username) ELSE COALESCE(agent_segment.username, live_offer.username) END AS agent_username,
      CASE WHEN w.state = 'offered' THEN COALESCE(live_offer.first_name, agent_segment.first_name) ELSE COALESCE(agent_segment.first_name, live_offer.first_name) END AS first_name,
      CASE WHEN w.state = 'offered' THEN COALESCE(live_offer.last_name, agent_segment.last_name) ELSE COALESCE(agent_segment.last_name, live_offer.last_name) END AS last_name,
      customer_leg.provider_call_id AS call_control_id,
      COALESCE(w.provider_session_id, customer_leg.provider_session_id, agent_leg.provider_session_id) AS call_session_id,
      w.direction,
      CASE w.state
        WHEN 'offered' THEN 'ringing'
        WHEN 'active' THEN 'connected'
        ELSE w.state
      END AS state,
      TRUE AS is_contact_center,
      CASE WHEN w.direction = 'inbound' THEN w.customer_address ELSE w.cc_address END AS from_number,
      CASE WHEN w.direction = 'inbound' THEN w.cc_address ELSE w.customer_address END AS to_number,
      NULLIF(w.attributes->>'customer_name', '') AS from_name,
      NULLIF(w.attributes->>'contact_center_name', '') AS to_name,
      w.required_skills,
      jsonb_build_object('timeline', COALESCE(timeline.events, '[]'::jsonb)) AS routing_metadata,
      NULLIF(w.attributes->>'flow_id', '') AS flow_id,
      w.enqueued_at,
      CASE WHEN w.state = 'offered' THEN live_offer.created_at ELSE COALESCE(agent_segment.started_at, live_offer.created_at) END AS assigned_at,
      metrics.answered_at,
      CASE WHEN w.state IN ('completed', 'failed') THEN w.terminal_at END AS completed_at,
      CASE WHEN w.state = 'abandoned' THEN w.terminal_at END AS abandoned_at,
      metrics.wait_time_seconds,
      metrics.handle_time_seconds,
      metrics.talk_time_seconds,
      metrics.transfer_count,
      COALESCE(transfers.items, '[]'::jsonb) AS transfer_history,
      holds.hold_count,
      holds.hold_duration_seconds,
      recording.recording_url,
      annotation.notes,
      COALESCE(annotation.tags, '[]'::jsonb) AS tags,
      COALESCE(metrics.wrapup_codes, '[]'::jsonb) AS wrapup_codes,
      jsonb_strip_nulls(
        COALESCE(w.attributes, '{}'::jsonb) ||
        jsonb_build_object(
          'work_item_id', w.id,
          'agent_call_control_id', agent_leg.provider_call_id,
          'agent_transport_call_control_id', agent_transport.provider_call_id,
          'original_call_control_id', customer_leg.provider_call_id,
          'recording', CASE WHEN recording.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', recording.id,
            'recording_id', recording.provider_recording_id,
            'recording_url', recording.recording_url,
            'recording_urls', recording.recording_urls,
            'format', recording.format,
            'channels', recording.channels,
            'recording_started_at', recording.started_at,
            'recording_ended_at', recording.ended_at
          ) END,
          'transcription_text', NULLIF(transcript.text, ''),
          'transcription_segments', transcript.segments,
          'transcription_speaker_turns', transcript.speaker_turns,
          'transcription_summary', transcript.summary
        )
      ) AS metadata,
      w.priority,
      w.terminal_at,
      w.terminal_reason,
      w.outbound_attempt_id,
      w.created_at,
      COALESCE(w.terminal_at, timeline.updated_at, w.created_at) AS updated_at,
      w.conversation_id, w.channel
    FROM acd_work_items w
    LEFT JOIN cc_queues q ON q.id = w.queue_id
    LEFT JOIN LATERAL (
      SELECT s.agent_id, u.username, u.first_name, u.last_name,
             s.started_at, s.answered_at, s.ended_at, s.seq
        FROM acd_segments s
        LEFT JOIN users u ON u.id = s.agent_id
       WHERE s.work_item_id = w.id AND s.kind = 'agent'
       ORDER BY (s.ended_at IS NULL) DESC, s.seq DESC
       LIMIT 1
    ) agent_segment ON TRUE
    LEFT JOIN LATERAL (
      SELECT o.agent_id, u.username, u.first_name, u.last_name, o.created_at
        FROM acd_offers o
        LEFT JOIN users u ON u.id = o.agent_id
       WHERE o.work_item_id = w.id AND o.state IN ('created', 'ringing', 'accepted')
       ORDER BY o.generation DESC
       LIMIT 1
    ) live_offer ON TRUE
    LEFT JOIN LATERAL (
      SELECT l.id, l.provider_call_id, l.provider_session_id
        FROM acd_legs l
       WHERE l.work_item_id = w.id AND l.role = 'customer'
       ORDER BY l.created_at ASC
       LIMIT 1
    ) customer_leg ON TRUE
    LEFT JOIN LATERAL (
      SELECT l.id, l.provider_call_id, l.provider_session_id
        FROM acd_legs l
       WHERE l.work_item_id = w.id AND l.role = 'agent_device'
       ORDER BY (l.ended_at IS NULL) DESC, l.created_at DESC
       LIMIT 1
    ) agent_leg ON TRUE
    LEFT JOIN LATERAL (
      SELECT l.provider_call_id
        FROM acd_legs l
       WHERE l.work_item_id = w.id AND l.role = 'agent_transport'
       ORDER BY (l.ended_at IS NULL) DESC, l.created_at DESC
       LIMIT 1
    ) agent_transport ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        MIN(s.answered_at) FILTER (WHERE s.kind = 'agent') AS answered_at,
        COALESCE(SUM(CASE WHEN s.kind = 'queue_wait' THEN
          GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s.ended_at, w.terminal_at, clock_timestamp()) - s.started_at)))
          ELSE 0 END), 0)::int AS wait_time_seconds,
        COALESCE(SUM(CASE WHEN s.kind = 'agent' AND s.answered_at IS NOT NULL THEN
          GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s.ended_at, w.terminal_at, clock_timestamp()) - s.answered_at)))
          ELSE 0 END), 0)::int AS talk_time_seconds,
        COALESCE(SUM(CASE WHEN s.kind = 'agent' THEN
          GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s.ended_at, w.terminal_at, clock_timestamp()) - COALESCE(s.answered_at, s.started_at)))) +
          CASE WHEN s.ended_at IS NOT NULL AND s.wrapup_ended_at IS NOT NULL THEN
            GREATEST(0, EXTRACT(EPOCH FROM (s.wrapup_ended_at - s.ended_at))) ELSE 0 END
          ELSE 0 END), 0)::int AS handle_time_seconds,
        COUNT(*) FILTER (WHERE s.kind = 'agent' AND s.outcome = 'transferred')::int AS transfer_count,
        COALESCE(jsonb_agg(DISTINCT to_jsonb(s.wrapup_code_id))
          FILTER (WHERE s.wrapup_code_id IS NOT NULL), '[]'::jsonb) AS wrapup_codes
      FROM acd_segments s WHERE s.work_item_id = w.id
    ) metrics ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE e.type = 'hold_started')::int AS hold_count,
        COALESCE(SUM(CASE WHEN e.type = 'hold_started' THEN
          GREATEST(0, EXTRACT(EPOCH FROM (
            COALESCE((SELECT MIN(e2.occurred_at) FROM acd_events e2
              WHERE e2.work_item_id = e.work_item_id AND e2.type = 'hold_ended' AND e2.id > e.id),
              w.terminal_at, clock_timestamp()) - e.occurred_at
          ))) ELSE 0 END), 0)::int AS hold_duration_seconds
      FROM acd_events e
      WHERE e.work_item_id = w.id AND e.type IN ('hold_started', 'hold_ended')
    ) holds ON TRUE
    LEFT JOIN LATERAL (
      SELECT r.* FROM acd_recordings r WHERE r.work_item_id = w.id
       ORDER BY r.created_at DESC LIMIT 1
    ) recording ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        (array_agg(t.text ORDER BY (t.source = 'recording') DESC, t.created_at DESC))[1] AS text,
        (array_agg(t.segments ORDER BY (t.source = 'recording') DESC, t.created_at DESC))[1] AS segments,
        (array_agg(t.speaker_turns ORDER BY (t.source = 'recording') DESC, t.created_at DESC))[1] AS speaker_turns,
        (array_agg(t.summary ORDER BY (t.source = 'recording') DESC, t.created_at DESC))[1] AS summary
      FROM acd_transcripts t WHERE t.work_item_id = w.id
    ) transcript ON TRUE
    LEFT JOIN acd_work_item_annotations annotation ON annotation.work_item_id = w.id
    LEFT JOIN LATERAL (
      -- The Core marker keys win over payload fields: an evidence payload that
      -- carries its own "source" (delivery receipts, transcripts) must never
      -- masquerade as a preserved legacy timeline entry.
      SELECT jsonb_agg(jsonb_strip_nulls(COALESCE(e.payload, '{}'::jsonb) || jsonb_build_object(
          'eventId', e.id, 'type', e.type, 'timestamp', e.occurred_at, 'source', 'acd_core'
        )) ORDER BY e.id) AS events,
        MAX(e.occurred_at) AS updated_at
      FROM acd_events e WHERE e.work_item_id = w.id
    ) timeline ON TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(e.payload ORDER BY e.id) AS items
        FROM acd_events e
       WHERE e.work_item_id = w.id
         AND e.type IN ('work_item_transferred', 'work_item_queue_transferred')
    ) transfers ON TRUE;
  `);
}

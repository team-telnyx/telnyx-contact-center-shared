import { resolveAcdArtifactContext } from "./artifacts.mjs";
import { createAcdHistoryDto } from "./history-contract.mjs";

function legacyState(state) {
  if (state === "active") return "connected";
  if (state === "offered") return "ringing";
  return state;
}

/**
 * Load one Core work item through its public id. The returned shape contains the common
 * interaction fields so product modules can migrate without inventing a
 * second history row.
 */
export async function findWorkItemByReference(db, reference) {
  if (!reference) return null;
  const result = await db.query(
    `SELECT w.*,
            q.name AS queue_name,
            agent_segment.agent_id,
            u.username AS agent_username,
            u.first_name AS agent_first_name,
            u.last_name AS agent_last_name,
            customer_leg.provider_call_id AS customer_call_control_id,
            customer_leg.provider_session_id AS customer_call_session_id,
            agent_leg.provider_call_id AS agent_call_control_id,
            agent_leg.provider_session_id AS agent_call_session_id
       FROM acd_work_items w
       LEFT JOIN cc_queues q ON q.id = w.queue_id
       LEFT JOIN LATERAL (
         SELECT s.agent_id
           FROM acd_segments s
          WHERE s.work_item_id = w.id AND s.kind = 'agent'
          ORDER BY (s.ended_at IS NULL) DESC, s.seq DESC
          LIMIT 1
       ) agent_segment ON true
       LEFT JOIN users u ON u.id = agent_segment.agent_id
       LEFT JOIN LATERAL (
         SELECT l.provider_call_id, l.provider_session_id
           FROM acd_legs l
          WHERE l.work_item_id = w.id AND l.role = 'customer'
          ORDER BY l.created_at DESC
          LIMIT 1
       ) customer_leg ON true
       LEFT JOIN LATERAL (
         SELECT l.provider_call_id, l.provider_session_id
           FROM acd_legs l
          WHERE l.work_item_id = w.id AND l.role = 'agent_device'
          ORDER BY l.created_at DESC
          LIMIT 1
       ) agent_leg ON true
      WHERE w.id::text = $1
      ORDER BY w.created_at DESC
      LIMIT 1`,
    [String(reference)],
  );
  const row = result.rows[0];
  if (!row) return null;
  const inbound = row.direction === "inbound";
  return {
    ...row,
    id: row.id,
    work_item_id: row.id,
    interaction_type: row.channel,
    state: legacyState(row.state),
    call_control_id: row.customer_call_control_id || row.agent_call_control_id || null,
    call_session_id:
      row.provider_session_id ||
      row.customer_call_session_id ||
      row.agent_call_session_id ||
      null,
    from_number: inbound ? row.customer_address : row.cc_address,
    to_number: inbound ? row.cc_address : row.customer_address,
    metadata: {
      ...(row.attributes || {}),
      agent_call_control_id: row.agent_call_control_id || null,
      original_call_control_id: row.customer_call_control_id || null,
    },
    routing_metadata: {},
    completed_at: row.state === "completed" ? row.terminal_at : null,
    abandoned_at: row.state === "abandoned" ? row.terminal_at : null,
  };
}

export async function findWorkItemByProviderIdentifiers(db, {
  callControlId = null,
  callSessionId = null,
} = {}) {
  const context = await resolveAcdArtifactContext(db, {
    call_control_id: callControlId,
    call_session_id: callSessionId,
  });
  return context ? findWorkItemByReference(db, context.work_item_id) : null;
}

export async function readWorkItemArtifacts(db, workItemId) {
  const [recordings, transcripts, annotations] = await Promise.all([
    db.query(
      `SELECT * FROM acd_recordings WHERE work_item_id = $1 ORDER BY created_at`,
      [workItemId],
    ),
    db.query(
      `SELECT * FROM acd_transcripts WHERE work_item_id = $1 ORDER BY occurred_at NULLS LAST, created_at`,
      [workItemId],
    ),
    db.query(
      `SELECT * FROM acd_work_item_annotations WHERE work_item_id = $1`,
      [workItemId],
    ),
  ]);
  return {
    recordings: recordings.rows,
    transcripts: transcripts.rows,
    annotations: annotations.rows,
  };
}

/** Product media view assembled from Core work items and typed artifacts. */
export async function findWorkItemWithArtifacts(db, reference) {
  const item = await findWorkItemByReference(db, reference);
  if (!item) return null;
  const artifacts = await readWorkItemArtifacts(db, item.work_item_id);
  const recording = artifacts.recordings.at(-1) || null;
  const savedTranscript = [...artifacts.transcripts]
    .reverse()
    .find((row) => row.source === "recording");
  const transcriptText = savedTranscript?.text || artifacts.transcripts
    .filter((row) => row.source === "live")
    .map((row) => row.text)
    .join("\n");
  return {
    ...item,
    recording_url: recording?.recording_url || null,
    metadata: {
      ...(item.metadata || {}),
      ...(recording
        ? {
            recording: {
              recording_id: recording.provider_recording_id,
              recording_url: recording.recording_url,
              recording_urls: recording.recording_urls,
              format: recording.format,
              channels: recording.channels,
              recording_started_at: recording.started_at,
              recording_ended_at: recording.ended_at,
            },
          }
        : {}),
      ...(transcriptText ? { transcription_text: transcriptText } : {}),
    },
    artifacts,
  };
}

function normalizeViewRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: String(row.id),
    work_item_id: String(row.work_item_id || row.id),
    agent_name:
      row.first_name || row.last_name
        ? `${row.first_name || ""} ${row.last_name || ""}`.trim()
        : row.agent_username || null,
    required_skills: row.required_skills || {},
    routing_metadata: row.routing_metadata || { timeline: [] },
    transfer_history: row.transfer_history || [],
    tags: row.tags || [],
    wrapup_codes: row.wrapup_codes || [],
    metadata: row.metadata || {},
  };
}

export async function findInteractionViewByReference(db, reference) {
  if (!reference) return null;
  const result = await db.query(
    `SELECT * FROM acd_history_interactions
      WHERE id::text = $1
      LIMIT 1`,
    [String(reference)],
  );
  return normalizeViewRow(result.rows[0]);
}

export async function findInteractionViewByCallControlId(db, callControlId) {
  if (!callControlId) return null;
  const result = await db.query(
    `SELECT h.*
       FROM acd_legs l
       JOIN acd_history_interactions h ON h.id = l.work_item_id
      WHERE l.provider_call_id = $1
      LIMIT 1`,
    [String(callControlId)],
  );
  return normalizeViewRow(result.rows[0]);
}

export async function findInteractionViewByCallSessionId(db, callSessionId) {
  if (!callSessionId) return null;
  const result = await db.query(
    `SELECT h.*
       FROM acd_history_interactions h
      WHERE h.call_session_id = $1
         OR EXISTS (
           SELECT 1 FROM acd_legs l
            WHERE l.work_item_id = h.id AND l.provider_session_id = $1
         )
      ORDER BY (h.terminal_at IS NULL) DESC, h.created_at DESC
      LIMIT 1`,
    [String(callSessionId)],
  );
  return normalizeViewRow(result.rows[0]);
}

export async function listAgentInteractionViews(db, agentId, {
  state = null,
  activeOnly = true,
  limit = 50,
} = {}) {
  if (!agentId) return [];
  const values = [String(agentId)];
  const where = [
    `(h.agent_id = $1 OR EXISTS (
      SELECT 1 FROM acd_segments s
       WHERE s.work_item_id = h.id AND s.kind = 'agent' AND s.agent_id = $1
    ))`,
  ];
  if (activeOnly) where.push("h.terminal_at IS NULL", "h.agent_id = $1", "h.state <> 'queued'");
  if (state) {
    values.push(String(state));
    where.push(`h.state = $${values.length}`);
  }
  // null is an internal, authenticated mobile projection request; the route
  // performs filtering and bounded response paging after merging offers.
  if (limit !== null) values.push(Math.min(100, Math.max(1, Number(limit) || 50)));
  const result = await db.query(
    `SELECT h.* FROM acd_history_interactions h
      WHERE ${where.join(" AND ")}
      ORDER BY h.created_at DESC
      ${limit === null ? "" : `LIMIT $${values.length}`}`,
    values,
  );
  return result.rows.map(normalizeViewRow);
}

const OPTIONAL_HISTORY_ORDER = Object.freeze({
  form_submissions: "created_at, id",
  aa_workflow_sessions: "started_at, id",
  quality_evaluations: "created_at, id",
});

export async function readOptionalHistoryRows(db, table, workItemId) {
  const orderBy = OPTIONAL_HISTORY_ORDER[table];
  if (!orderBy) {
    throw new TypeError(`Unsupported optional history table: ${table}`);
  }
  const exists = await db.query(`SELECT to_regclass($1) AS relation`, [`public.${table}`]);
  if (!exists.rows[0]?.relation) return [];
  const result = await db.query(
    `SELECT * FROM ${table} WHERE work_item_id = $1 ORDER BY ${orderBy}`,
    [workItemId],
  );
  return result.rows;
}

/** Load the complete, versioned Core history aggregate for one work item. */
export async function loadAcdHistoryDto(db, reference) {
  const workItemResult = await db.query(
    `SELECT * FROM acd_work_items WHERE id::text = $1 LIMIT 1`,
    [String(reference)],
  );
  const workItem = workItemResult.rows[0];
  if (!workItem) return null;

  const [segments, offers, legs, events, recordings, transcripts, annotations,
    formSubmissions, agentAssistSessions, qualityEvaluations, outboundAttempts] =
    await Promise.all([
      db.query(`SELECT * FROM acd_segments WHERE work_item_id=$1 ORDER BY seq`, [workItem.id]),
      db.query(`SELECT * FROM acd_offers WHERE work_item_id=$1 ORDER BY generation`, [workItem.id]),
      db.query(`SELECT * FROM acd_legs WHERE work_item_id=$1 ORDER BY created_at`, [workItem.id]),
      db.query(`SELECT * FROM acd_events WHERE work_item_id=$1 ORDER BY id`, [workItem.id]),
      db.query(`SELECT * FROM acd_recordings WHERE work_item_id=$1 ORDER BY created_at`, [workItem.id]),
      db.query(`SELECT * FROM acd_transcripts WHERE work_item_id=$1 ORDER BY occurred_at NULLS LAST, created_at`, [workItem.id]),
      db.query(`SELECT * FROM acd_work_item_annotations WHERE work_item_id=$1`, [workItem.id]),
      readOptionalHistoryRows(db, "form_submissions", workItem.id),
      readOptionalHistoryRows(db, "aa_workflow_sessions", workItem.id),
      readOptionalHistoryRows(db, "quality_evaluations", workItem.id),
      workItem.outbound_attempt_id
        ? db.query(`SELECT * FROM outbound_attempt_ledger WHERE id::text=$1`, [workItem.outbound_attempt_id])
        : Promise.resolve({ rows: [] }),
    ]);

  const agentIds = [...new Set([
    ...segments.rows.map((row) => row.agent_id),
    ...offers.rows.map((row) => row.agent_id),
    ...legs.rows.map((row) => row.agent_id),
  ].filter(Boolean))];
  const queueIds = [...new Set([
    workItem.queue_id,
    ...segments.rows.map((row) => row.queue_id),
  ].filter(Boolean))];
  const wrapupIds = [...new Set(segments.rows.map((row) => row.wrapup_code_id).filter(Boolean))];
  const [agents, queues, wrapupCodes, statusIntervals] = await Promise.all([
    agentIds.length
      ? db.query(`SELECT * FROM users WHERE id = ANY($1::text[])`, [agentIds])
      : Promise.resolve({ rows: [] }),
    queueIds.length
      ? db.query(`SELECT * FROM cc_queues WHERE id = ANY($1::text[])`, [queueIds])
      : Promise.resolve({ rows: [] }),
    wrapupIds.length
      ? db.query(`SELECT * FROM cc_wrapup_codes WHERE id = ANY($1::text[])`, [wrapupIds])
      : Promise.resolve({ rows: [] }),
    agentIds.length
      ? db.query(
          `SELECT * FROM cc_agent_status_intervals
            WHERE user_id = ANY($1::text[])
              AND started_at <= COALESCE($3::timestamptz, clock_timestamp())
              AND ended_at >= $2::timestamptz
            ORDER BY started_at`,
          [agentIds, workItem.created_at, workItem.terminal_at],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const asMap = (rows) => Object.fromEntries(rows.map((row) => [row.id, row]));

  return createAcdHistoryDto({
    workItem,
    segments: segments.rows,
    offers: offers.rows,
    legs: legs.rows,
    events: events.rows,
    statusIntervals: statusIntervals.rows,
    recordings: recordings.rows,
    transcripts: transcripts.rows,
    annotations: annotations.rows,
    formSubmissions,
    agentAssistSessions,
    qualityEvaluations,
    outboundAttempts: outboundAttempts.rows,
    lookups: {
      agents: asMap(agents.rows),
      queues: asMap(queues.rows),
      wrapupCodes: asMap(wrapupCodes.rows),
    },
  });
}

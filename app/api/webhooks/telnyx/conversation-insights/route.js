import { NextResponse } from "next/server";
import { verifyTelnyxSignature } from "@/lib/telnyx-webhooks";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { broadcastToKey } from "@/lib/sse";
import { findWorkflowByInsightGroup } from "@/lib/telnyx-insights";
import { telnyxErrorPayload, telnyxResourcePayload, telnyxWebhookLogger } from "@/lib/telnyx-ai-logging.mjs";
import { findWorkItemByProviderIdentifiers } from "@/lib/acd/work-item-repository.mjs";

export const dynamic = "force-dynamic";

/**
 * Find interaction by call identifiers
 * @param {Object} params - Search parameters
 * @param {string} params.callSessionId - Call session ID
 * @param {string} params.callLegId - Call leg ID
 * @param {string} params.aiCallControlId - AI call control ID
 * @returns {Promise<Object|null>} Interaction or null
 */
async function findInteractionForAiHandoff({ callSessionId, callLegId, aiCallControlId }) {
  const pool = getPostgresPool();
  if (!pool) return null;

  return findWorkItemByProviderIdentifiers(pool, {
    callControlId: aiCallControlId || callLegId || null,
    callSessionId,
  });
}

/**
 * Find workflow session by interaction ID
 * @param {string} interactionId - Interaction ID
 * @returns {Promise<Object|null>} Workflow session or null
 */
async function findWorkflowSessionByInteraction(interactionId) {
  const pool = getPostgresPool();
  if (!pool) return null;

  const { rows: [session] } = await pool.query(
    `SELECT * FROM aa_workflow_sessions
      WHERE work_item_id::text = $1`,
    [interactionId]
  );

  return session || null;
}

/**
 * Store AI handoff event in database
 * @param {Object} params - Event data
 * @returns {Promise<string>} Event ID
 */
async function storeHandoffEvent({
  workItemId,
  workflowSessionId,
  aiCallControlId,
  insightGroupId,
  rawPayload,
  processedSlots,
  status,
  errorMessage,
}) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Database not available");

  const { rows: [event] } = await pool.query(
    `INSERT INTO aa_ai_handoff_events 
     (work_item_id, workflow_session_id, ai_call_control_id, insight_group_id,
      raw_payload, processed_slots, status, error_message, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     RETURNING id`,
    [
      workItemId || null,
      workflowSessionId || null,
      aiCallControlId,
      insightGroupId,
      JSON.stringify(rawPayload),
      processedSlots ? JSON.stringify(processedSlots) : null,
      status,
      errorMessage || null,
    ]
  );

  return event.id;
}

/**
 * Mark handoff event as processed
 * @param {string} eventId - Event ID
 * @param {string} sessionId - Workflow session ID
 */
async function markEventProcessed(eventId, sessionId) {
  const pool = getPostgresPool();
  if (!pool) return;

  await pool.query(
    `UPDATE aa_ai_handoff_events 
     SET status = 'processed', workflow_session_id = $2, processed_at = NOW()
     WHERE id = $1`,
    [eventId, sessionId]
  );
}

/**
 * Mark event as ready for session (when session doesn't exist yet)
 * @param {string} eventId - Event ID
 * @param {string} interactionId - Interaction ID
 */
async function markEventReadyForSession(eventId, workItemId) {
  const pool = getPostgresPool();
  if (!pool) return;

  await pool.query(
    `UPDATE aa_ai_handoff_events 
     SET status = 'pending_session', work_item_id = $2
     WHERE id = $1`,
    [eventId, workItemId || null]
  );
}

/**
 * Filter out invalid slot values (null strings, low confidence)
 * @param {Object} slots - Raw slots object from insight
 * @returns {Object} Filtered slots
 */
function filterValidSlots(slots) {
  const filtered = {};
  
  for (const [slotName, slotData] of Object.entries(slots || {})) {
    // Skip if no data
    if (!slotData) continue;
    
    const value = slotData.value;
    const confidence = slotData.confidence;
    
    // Skip null/undefined values
    if (value === null || value === undefined) continue;
    
    // Skip string "null" or "None" (LLM artifact)
    if (typeof value === "string" && ["null", "none", "n/a", ""].includes(value.toLowerCase().trim())) {
      continue;
    }
    
    // Skip low confidence (< 0.5)
    if (typeof confidence === "number" && confidence < 0.5) continue;
    
    // Valid slot - include it
    filtered[slotName] = slotData;
  }
  
  return filtered;
}

/**
 * Parse insight results from webhook payload
 * @param {Array} results - Array of insight results
 * @param {Object} workflow - Workflow with insight IDs
 * @returns {Object} Parsed data
 */
function parseInsightResults(results, workflow) {
  const data = {
    slots: {},
    completedStages: [],
    summary: null,
    sentiment: null,
  };

  for (const result of results || []) {
    const insightId = result.insight_id;
    const content = result.result;

    if (insightId === workflow.insight_slots_id) {
      // Slots insight - structured JSON
      try {
        const parsed = typeof content === "string" ? JSON.parse(content) : content;
        // Filter out invalid values (null strings, low confidence)
        data.slots = filterValidSlots(parsed?.slots || {});
        data.completedStages = parsed?.completed_stages || [];
      } catch (err) {
        telnyxWebhookLogger.warn("conversation_insight_slots_parse_failed", { ...telnyxResourcePayload({ insightId }), ...telnyxErrorPayload(err) });
      }
    } else if (insightId === workflow.insight_summary_id) {
      // Summary insight - markdown text
      data.summary = typeof content === "string" ? content : JSON.stringify(content);
    } else if (insightId === workflow.insight_sentiment_id) {
      // Sentiment insight - markdown text
      data.sentiment = typeof content === "string" ? content : JSON.stringify(content);
    }
  }

  return data;
}

/**
 * Update workflow session with AI-collected data
 * @param {string} sessionId - Workflow session ID
 * @param {Object} data - Parsed insight data
 * @param {Object} workflow - Workflow with stages
 */
async function updateWorkflowSession(sessionId, data, workflow) {
  const pool = getPostgresPool();
  if (!pool) return;

  // Build only the AI slot keys that are eligible to land. The actual merge is
  // performed in PostgreSQL while the session row is locked so a snapshot read
  // before a concurrent agent/MCP write can never erase that newer state.
  const incomingSlots = {};
  for (const [slotName, slotData] of Object.entries(data.slots || {})) {
    const value = slotData?.value;
    if (value !== null && value !== undefined) incomingSlots[slotName] = value;
  }

  const { rows: [slotWrite] } = await pool.query(
    `WITH previous AS MATERIALIZED (
       SELECT id, COALESCE(slots_filled, '{}'::jsonb) AS slots_filled
         FROM aa_workflow_sessions
        WHERE id = $4
        FOR UPDATE
     )
     UPDATE aa_workflow_sessions s SET
       slots_filled = $1::jsonb || previous.slots_filled,
       slots_version = COALESCE(s.slots_version, 0) +
         CASE WHEN ($1::jsonb || previous.slots_filled) IS DISTINCT FROM previous.slots_filled THEN 1 ELSE 0 END,
       ai_summary = COALESCE($2, s.ai_summary),
       ai_sentiment = COALESCE($3, s.ai_sentiment),
       ai_handoff_received_at = NOW(),
       ai_handoff_source = 'webhook',
       updated_at = NOW()
     FROM previous
     WHERE s.id = previous.id
     RETURNING previous.slots_filled AS previous_slots, s.slots_filled`,
    [JSON.stringify(incomingSlots), data.summary, data.sentiment, sessionId]
  );
  const previousSlots = slotWrite?.previous_slots || {};

  // 2. Update item statuses only for AI slots that actually won the session
  // merge. Existing agent/MCP keys are authoritative and must retain both their
  // value and provenance.
  const { rows: items } = await pool.query(
    `SELECT i.id, i.slot_name 
     FROM aa_workflow_items i
     JOIN aa_workflow_stages s ON i.stage_id = s.id
     WHERE s.workflow_id = $1 AND i.slot_name IS NOT NULL`,
    [workflow.id]
  );

  const itemMap = new Map(items.map((i) => [i.slot_name, i.id]));

  for (const [slotName, slotData] of Object.entries(data.slots || {})) {
    if (Object.prototype.hasOwnProperty.call(previousSlots, slotName)) continue;
    const itemId = itemMap.get(slotName);
    if (!itemId) continue;

    const value = slotData?.value;
    const confidence = slotData?.confidence;

    // Only mark as completed if we have a value and reasonable confidence
    if (value !== null && value !== undefined && (confidence === undefined || confidence >= 0.6)) {
      await pool.query(
        `INSERT INTO aa_workflow_item_status (session_id, item_id, status, extracted_value, confidence_score, completed_at, completed_by, source_transcript, alternatives)
         VALUES ($1, $2, 'completed', $3, $4, NOW(), 'ai', $5, $6::jsonb)
         ON CONFLICT (session_id, item_id) 
         DO UPDATE SET
           status = CASE WHEN aa_workflow_item_status.completed_by IN ('agent', 'mcp', 'mcp_selected') THEN aa_workflow_item_status.status ELSE 'completed' END,
           extracted_value = CASE WHEN aa_workflow_item_status.completed_by IN ('agent', 'mcp', 'mcp_selected') THEN aa_workflow_item_status.extracted_value ELSE $3 END,
           confidence_score = CASE WHEN aa_workflow_item_status.completed_by IN ('agent', 'mcp', 'mcp_selected') THEN aa_workflow_item_status.confidence_score ELSE $4 END,
           completed_at = CASE WHEN aa_workflow_item_status.completed_by IN ('agent', 'mcp', 'mcp_selected') THEN aa_workflow_item_status.completed_at ELSE NOW() END,
           completed_by = CASE WHEN aa_workflow_item_status.completed_by IN ('agent', 'mcp', 'mcp_selected') THEN aa_workflow_item_status.completed_by ELSE 'ai' END,
           source_transcript = CASE WHEN aa_workflow_item_status.completed_by IN ('agent', 'mcp', 'mcp_selected') THEN aa_workflow_item_status.source_transcript ELSE $5 END,
           alternatives = CASE WHEN aa_workflow_item_status.completed_by IN ('agent', 'mcp', 'mcp_selected') THEN aa_workflow_item_status.alternatives ELSE $6::jsonb END,
           updated_at = NOW()`,
        [
          sessionId,
          itemId,
          typeof value === "string" ? value : JSON.stringify(value),
          confidence || null,
          slotData?.source_utterance || null,
          Array.isArray(slotData?.alternatives) && slotData.alternatives.length > 0 ? JSON.stringify(slotData.alternatives) : null,
        ]
      );
    }
  }

  // 3. Recalculate completion percentage
  const { rows: [stats] } = await pool.query(
    `SELECT 
       COUNT(*) as total,
       COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed
     FROM aa_workflow_item_status
     WHERE session_id = $1`,
    [sessionId]
  );

  const percentage = stats.total > 0 
    ? Math.round((stats.completed / stats.total) * 100) 
    : 0;

  await pool.query(
    `UPDATE aa_workflow_sessions SET completion_percentage = $1, updated_at = NOW() WHERE id = $2`,
    [percentage, sessionId]
  );
}

/**
 * Broadcast AI handoff data to agent via SSE
 * @param {Object} interaction - Interaction record
 * @param {string} sessionId - Workflow session ID
 * @param {Object} data - Parsed insight data
 */
async function broadcastAiHandoffData(interaction, sessionId, data) {
  if (!interaction?.agent_username) return;

  try {
    const pool = getPostgresPool();
    const agent = pool
      ? (
          await pool.query(
            `SELECT id, username FROM users WHERE username = $1 LIMIT 1`,
            [interaction.agent_username],
          )
        ).rows[0]
      : null;
    if (!agent?.id) return;

    // Transform slots for frontend (extract just values for simple slots_filled object)
    const slotsFilled = {};
    for (const [key, val] of Object.entries(data.slots || {})) {
      slotsFilled[key] = val?.value ?? val;
    }

    const payload = {
      type: "ai_handoff_data",
      interactionId: interaction.id,
      sessionId,
      data: {
        slots_filled: slotsFilled,
        slots_details: data.slots, // Full slot data with confidence
        summary: data.summary,
        sentiment: data.sentiment,
        completed_stages: data.completedStages,
        received_at: new Date().toISOString(),
      },
    };

    // Broadcast to user status stream (agent desktop listens here)
    await broadcastToKey(`user:status:${agent.id}`, payload);
    
    // Also broadcast to contact-center agent stream
    await broadcastToKey(`contact-center:agent:${agent.username}`, payload);

    telnyxWebhookLogger.info("conversation_insight_handoff_broadcasted", { ...telnyxResourcePayload({ interactionId: interaction.id, sessionId }) });
  } catch (err) {
    telnyxWebhookLogger.error("conversation_insight_handoff_broadcast_failed", { ...telnyxResourcePayload({ interactionId: interaction?.id, sessionId }), ...telnyxErrorPayload(err) });
  }
}

/**
 * Verify API key from custom header (alternative to Telnyx signature)
 * 
 * Header name is defined in TELNYX_AI_API_KEY_REF env var (e.g., "telnyx-ai-api-key")
 * Expected key value is defined in TELNYX_AI_API_KEY env var
 * 
 * Example:
 *   TELNYX_AI_API_KEY_REF=telnyx-ai-api-key
 *   TELNYX_AI_API_KEY=secret123
 *   → expects header: telnyx-ai-api-key: secret123
 */
function verifyApiKeyHeader(request) {
  const headerName = process.env.TELNYX_AI_API_KEY_REF;
  const expectedKey = process.env.TELNYX_AI_API_KEY;
  
  if (!headerName || !expectedKey) return false;

  const headerValue = request.headers.get(headerName);
  return headerValue === expectedKey;
}

/**
 * POST /api/webhooks/telnyx/conversation-insights
 * 
 * Webhook endpoint for receiving Telnyx Conversation Insights.
 * Called when AI assistant conversation ends (transfer or hangup).
 * 
 * Authentication: Telnyx Ed25519 signature verification
 */
export async function POST(request) {
  const startTime = Date.now();
  const requestId = `req-${crypto.randomUUID()}`;
  
  try {
    // Read raw body for signature verification
    const rawBody = await request.text();
    
    // Verify Telnyx signature
    const apiKeyValid = verifyApiKeyHeader(request);
    const signatureValid = await verifyTelnyxSignature(request, rawBody);
    
    if (!apiKeyValid && !signatureValid) {
      telnyxWebhookLogger.warn("conversation_insight_rejected", { requestId, reason: "invalid_signature" });
      return NextResponse.json(
        { ok: false, error: "Unauthorized - invalid signature" },
        { status: 401 }
      );
    }

    // Parse payload
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (err) {
      telnyxWebhookLogger.warn("conversation_insight_invalid_json", { requestId, ...telnyxErrorPayload(err) });
      return NextResponse.json(
        { ok: false, error: "Invalid JSON" },
        { status: 400 }
      );
    }

    // Validate event type
    // Telnyx AI sends "conversation_insight_result", not "call.conversation_insights.generated"
    const eventType = payload?.data?.event_type || payload?.event_type;
    const validEventTypes = ["conversation_insight_result", "call.conversation_insights.generated"];
    if (!validEventTypes.includes(eventType)) {
      return NextResponse.json({ ok: true, ignored: true, eventType });
    }

    // Extract key data from payload
    // Telnyx AI uses payload.payload structure with metadata containing call info
    const eventPayload = payload?.data?.payload || payload?.payload || {};
    const metadata = eventPayload?.metadata || {};
    
    // Call identifiers can be in eventPayload directly OR in metadata
    const callControlId = eventPayload.call_control_id || metadata.call_control_id;
    const callSessionId = eventPayload.call_session_id || metadata.call_session_id;
    const callLegId = eventPayload.call_leg_id || metadata.call_leg_id;
    const insightGroupId = eventPayload.insight_group_id;
    const results = eventPayload.results || [];

    telnyxWebhookLogger.info("conversation_insight_processing_started", { requestId, ...telnyxResourcePayload({ groupId: insightGroupId }), resultCount: results?.length || 0 });

    // Find workflow by insight_group_id
    const workflow = await findWorkflowByInsightGroup(insightGroupId);
    if (!workflow) {
      telnyxWebhookLogger.warn("conversation_insight_workflow_not_found", { requestId, ...telnyxResourcePayload({ groupId: insightGroupId }) });
      // Store event anyway for debugging
      await storeHandoffEvent({
        aiCallControlId: callControlId,
        insightGroupId,
        rawPayload: payload,
        status: "failed",
        errorMessage: "Workflow not found for insight_group_id",
      });
      return NextResponse.json({ ok: true, processed: false, reason: "workflow_not_found" });
    }

    // Find interaction
    const interaction = await findInteractionForAiHandoff({
      callSessionId,
      callLegId,
      aiCallControlId: callControlId,
    });
    const workItemId = interaction?.work_item_id || null;
    // Store raw event
    const eventId = await storeHandoffEvent({
      workItemId,
      aiCallControlId: callControlId,
      insightGroupId,
      rawPayload: payload,
      status: interaction ? "processing" : "pending_interaction",
    });

    if (!interaction) {
      telnyxWebhookLogger.info("conversation_insight_interaction_pending", { requestId, ...telnyxResourcePayload({ eventId, groupId: insightGroupId }) });
      return NextResponse.json({
        ok: true,
        processed: false,
        eventId,
        reason: "interaction_pending",
      });
    }

    // Parse insight results
    const parsedData = parseInsightResults(results, workflow);

    // Find workflow session
    const session = await findWorkflowSessionByInteraction(interaction.id);

    if (session) {
      // Update existing session with AI data
      await updateWorkflowSession(session.id, parsedData, workflow);
      await markEventProcessed(eventId, session.id);

      // Broadcast to agent
      await broadcastAiHandoffData(interaction, session.id, parsedData);

      const duration = Date.now() - startTime;
      telnyxWebhookLogger.info("conversation_insight_session_updated", { requestId, ...telnyxResourcePayload({ eventId, interactionId: interaction.id, sessionId: session.id }), durationMs: duration, slotCount: Object.keys(parsedData.slots).length });

      return NextResponse.json({
        ok: true,
        processed: true,
        sessionUpdated: true,
        sessionId: session.id,
        slotsExtracted: Object.keys(parsedData.slots).length,
        duration,
      });
    } else {
      // Session doesn't exist yet - data will be applied when session starts
      await markEventReadyForSession(eventId, workItemId);

      // Store processed slots in the event for later application
      const pool = getPostgresPool();
      if (pool) {
        await pool.query(
          `UPDATE aa_ai_handoff_events SET processed_slots = $1 WHERE id = $2`,
          [JSON.stringify(parsedData), eventId]
        );
      }

      const duration = Date.now() - startTime;
      telnyxWebhookLogger.info("conversation_insight_pending_session_stored", { requestId, ...telnyxResourcePayload({ eventId, interactionId: interaction.id }), durationMs: duration, slotCount: Object.keys(parsedData.slots).length });

      return NextResponse.json({
        ok: true,
        processed: true,
        sessionUpdated: false,
        pendingForSession: true,
        interactionId: interaction.id,
        duration,
      });
    }
  } catch (err) {
    telnyxWebhookLogger.error("conversation_insight_processing_failed", { requestId, ...telnyxErrorPayload(err) });
    return NextResponse.json(
      { ok: false, error: err.message || String(err) },
      { status: 500 }
    );
  }
}

/**
 * GET /api/webhooks/telnyx/conversation-insights
 * 
 * Health check endpoint for webhook verification.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "conversation-insights-webhook",
    timestamp: new Date().toISOString(),
  });
}

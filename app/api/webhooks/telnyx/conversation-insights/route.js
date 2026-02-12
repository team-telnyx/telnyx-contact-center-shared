import { NextResponse } from "next/server";
import { verifyTelnyxSignature } from "@/lib/telnyx-webhooks";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { broadcastToKey } from "@/lib/sse";
import { findWorkflowByInsightGroup } from "@/lib/telnyx-insights";

export const dynamic = "force-dynamic";

const LOG_PREFIX = "[Insights Webhook]";

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

  // Try multiple strategies to find the interaction
  // 1. By call_session_id (most reliable after transfer)
  if (callSessionId) {
    const { rows: [interaction] } = await pool.query(
      `SELECT * FROM cc_interactions WHERE call_session_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [callSessionId]
    );
    if (interaction) return interaction;
  }

  // 2. By ai_call_control_id in metadata (stored during transfer)
  if (aiCallControlId) {
    const { rows: [interaction] } = await pool.query(
      `SELECT * FROM cc_interactions 
       WHERE metadata->>'ai_call_control_id' = $1 
       ORDER BY created_at DESC LIMIT 1`,
      [aiCallControlId]
    );
    if (interaction) return interaction;
  }

  // 3. By call_leg_id in routing_metadata
  if (callLegId) {
    const { rows: [interaction] } = await pool.query(
      `SELECT * FROM cc_interactions 
       WHERE routing_metadata->>'call_leg_id' = $1 
       ORDER BY created_at DESC LIMIT 1`,
      [callLegId]
    );
    if (interaction) return interaction;
  }

  return null;
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
    `SELECT * FROM aa_workflow_sessions WHERE interaction_id = $1`,
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
  interactionId,
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
     (interaction_id, workflow_session_id, ai_call_control_id, insight_group_id, 
      raw_payload, processed_slots, status, error_message, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     RETURNING id`,
    [
      interactionId || null,
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
async function markEventReadyForSession(eventId, interactionId) {
  const pool = getPostgresPool();
  if (!pool) return;

  await pool.query(
    `UPDATE aa_ai_handoff_events 
     SET status = 'pending_session', interaction_id = $2
     WHERE id = $1`,
    [eventId, interactionId]
  );
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
        data.slots = parsed?.slots || {};
        data.completedStages = parsed?.completed_stages || [];
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to parse slots result:`, err);
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

  // 1. Update session with summary, sentiment, slots
  const existingSession = await pool.query(
    `SELECT slots_filled FROM aa_workflow_sessions WHERE id = $1`,
    [sessionId]
  );
  
  const currentSlots = existingSession.rows[0]?.slots_filled || {};
  
  // Merge AI slots with existing slots (don't overwrite agent-entered data)
  const mergedSlots = { ...currentSlots };
  for (const [slotName, slotData] of Object.entries(data.slots)) {
    // Only add if not already filled by agent
    if (!currentSlots[slotName]) {
      mergedSlots[slotName] = slotData?.value;
    }
  }

  await pool.query(
    `UPDATE aa_workflow_sessions SET
      slots_filled = $1::jsonb,
      ai_summary = COALESCE($2, ai_summary),
      ai_sentiment = COALESCE($3, ai_sentiment),
      ai_handoff_received_at = NOW(),
      ai_handoff_source = 'webhook',
      updated_at = NOW()
    WHERE id = $4`,
    [
      JSON.stringify(mergedSlots),
      data.summary,
      data.sentiment,
      sessionId,
    ]
  );

  // 2. Update item statuses for filled slots
  // Get workflow items with slot_name
  const { rows: items } = await pool.query(
    `SELECT i.id, i.slot_name 
     FROM aa_workflow_items i
     JOIN aa_workflow_stages s ON i.stage_id = s.id
     WHERE s.workflow_id = $1 AND i.slot_name IS NOT NULL`,
    [workflow.id]
  );

  const itemMap = new Map(items.map((i) => [i.slot_name, i.id]));

  for (const [slotName, slotData] of Object.entries(data.slots)) {
    const itemId = itemMap.get(slotName);
    if (!itemId) continue;

    const value = slotData?.value;
    const confidence = slotData?.confidence;

    // Only mark as completed if we have a value and reasonable confidence
    if (value !== null && value !== undefined && (confidence === undefined || confidence >= 0.6)) {
      // Check if already completed by agent (don't overwrite)
      const { rows: [existingStatus] } = await pool.query(
        `SELECT completed_by FROM aa_workflow_item_status 
         WHERE session_id = $1 AND item_id = $2`,
        [sessionId, itemId]
      );

      if (existingStatus?.completed_by === "agent") {
        // Don't overwrite agent's work
        continue;
      }

      await pool.query(
        `INSERT INTO aa_workflow_item_status (session_id, item_id, status, extracted_value, confidence_score, completed_at, completed_by, source_transcript)
         VALUES ($1, $2, 'completed', $3, $4, NOW(), 'ai', $5)
         ON CONFLICT (session_id, item_id) 
         DO UPDATE SET
           status = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.status ELSE 'completed' END,
           extracted_value = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.extracted_value ELSE $3 END,
           confidence_score = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.confidence_score ELSE $4 END,
           completed_at = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.completed_at ELSE NOW() END,
           completed_by = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN 'agent' ELSE 'ai' END,
           source_transcript = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.source_transcript ELSE $5 END,
           updated_at = NOW()`,
        [
          sessionId,
          itemId,
          typeof value === "string" ? value : JSON.stringify(value),
          confidence || null,
          slotData?.source_utterance || null,
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
    const { PgDb } = await import("@/lib/pgdb.js");
    const agent = await PgDb.findUserByUsername(interaction.agent_username);
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

    console.log(`${LOG_PREFIX} Broadcasted AI handoff data to agent ${agent.username}`);
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to broadcast to agent:`, err);
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
 * Authentication (either one must pass):
 * 1. Telnyx webhook signature verification
 * 2. API key via Authorization: Bearer <key> or X-API-Key: <key>
 *    (key defined in TELNYX_AI_API_KEY_REF env var)
 */
export async function POST(request) {
  const startTime = Date.now();
  
  try {
    // Read raw body for signature verification
    const rawBody = await request.text();
    
    // Try API key authentication first (faster, no crypto)
    const apiKeyValid = verifyApiKeyHeader(request);
    
    // If no API key, verify Telnyx webhook signature
    let signatureValid = false;
    if (!apiKeyValid) {
      signatureValid = await verifyTelnyxSignature(request, rawBody);
    }
    
    if (!apiKeyValid && !signatureValid) {
      console.warn(`${LOG_PREFIX} Authentication failed - neither API key nor signature valid`);
      return NextResponse.json(
        { ok: false, error: "Unauthorized - invalid API key or signature" },
        { status: 401 }
      );
    }
    
    console.log(`${LOG_PREFIX} Authenticated via ${apiKeyValid ? 'API key' : 'Telnyx signature'}`);


    // Parse payload
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (err) {
      console.error(`${LOG_PREFIX} Invalid JSON payload:`, err);
      return NextResponse.json(
        { ok: false, error: "Invalid JSON" },
        { status: 400 }
      );
    }

    // Validate event type
    const eventType = payload?.data?.event_type || payload?.event_type;
    if (eventType !== "call.conversation_insights.generated") {
      console.log(`${LOG_PREFIX} Ignoring event type: ${eventType}`);
      return NextResponse.json({ ok: true, ignored: true });
    }

    // Extract key data from payload
    const eventPayload = payload?.data?.payload || payload?.payload || {};
    const {
      call_control_id: callControlId,
      call_session_id: callSessionId,
      call_leg_id: callLegId,
      insight_group_id: insightGroupId,
      results,
    } = eventPayload;

    console.log(`${LOG_PREFIX} Processing insights webhook:`, {
      callControlId: callControlId?.slice(0, 20) + "...",
      callSessionId,
      insightGroupId,
      resultsCount: results?.length || 0,
    });

    // Find workflow by insight_group_id
    const workflow = await findWorkflowByInsightGroup(insightGroupId);
    if (!workflow) {
      console.warn(`${LOG_PREFIX} No workflow found for insight_group_id: ${insightGroupId}`);
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

    // Store raw event
    const eventId = await storeHandoffEvent({
      interactionId: interaction?.id,
      aiCallControlId: callControlId,
      insightGroupId,
      rawPayload: payload,
      status: interaction ? "processing" : "pending_interaction",
    });

    if (!interaction) {
      console.log(`${LOG_PREFIX} Interaction not found yet, stored event for later processing`);
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
      console.log(`${LOG_PREFIX} Processed in ${duration}ms - session updated: ${session.id}`);

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
      await markEventReadyForSession(eventId, interaction.id);

      // Store processed slots in the event for later application
      const pool = getPostgresPool();
      if (pool) {
        await pool.query(
          `UPDATE aa_ai_handoff_events SET processed_slots = $1 WHERE id = $2`,
          [JSON.stringify(parsedData), eventId]
        );
      }

      const duration = Date.now() - startTime;
      console.log(`${LOG_PREFIX} Processed in ${duration}ms - stored for pending session`);

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
    console.error(`${LOG_PREFIX} Error processing webhook:`, err);
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

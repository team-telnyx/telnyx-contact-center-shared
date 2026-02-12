/**
 * AI Handoff Processor
 * 
 * Handles processing of AI-to-agent workflow handoffs.
 * Processes pending insight events and updates workflow sessions.
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import { broadcastToKey } from "@/lib/sse";

const LOG_PREFIX = "[AI Handoff]";

/**
 * Parse insight results from stored event payload
 * @param {Object} rawPayload - Raw webhook payload or processed_slots
 * @param {Object} workflow - Workflow with insight IDs
 * @returns {Object} Parsed data with slots, summary, sentiment
 */
function parseInsightResults(rawPayload, workflow) {
  // If we have pre-processed slots, use them directly
  if (rawPayload?.slots && !rawPayload?.data?.payload) {
    return rawPayload;
  }

  const data = {
    slots: {},
    completedStages: [],
    summary: null,
    sentiment: null,
  };

  // Handle both raw payload and processed_slots formats
  const results = rawPayload?.data?.payload?.results || 
                  rawPayload?.payload?.results || 
                  rawPayload?.results || 
                  [];

  for (const result of results) {
    const insightId = result.insight_id;
    const content = result.result;

    if (insightId === workflow?.insight_slots_id) {
      try {
        const parsed = typeof content === "string" ? JSON.parse(content) : content;
        data.slots = parsed?.slots || {};
        data.completedStages = parsed?.completed_stages || [];
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to parse slots result:`, err);
      }
    } else if (insightId === workflow?.insight_summary_id) {
      data.summary = typeof content === "string" ? content : JSON.stringify(content);
    } else if (insightId === workflow?.insight_sentiment_id) {
      data.sentiment = typeof content === "string" ? content : JSON.stringify(content);
    }
  }

  return data;
}

/**
 * Update workflow session with AI-collected data
 * @param {Object} pool - Database pool
 * @param {string} sessionId - Workflow session ID
 * @param {Object} data - Parsed insight data
 * @param {Object} workflow - Workflow object
 */
async function updateWorkflowSessionWithAiData(pool, sessionId, data, workflow) {
  // 1. Get current session state
  const { rows: [currentSession] } = await pool.query(
    `SELECT slots_filled FROM aa_workflow_sessions WHERE id = $1`,
    [sessionId]
  );

  const currentSlots = currentSession?.slots_filled || {};

  // 2. Merge AI slots with existing slots (don't overwrite agent-entered data)
  const mergedSlots = { ...currentSlots };
  for (const [slotName, slotData] of Object.entries(data.slots || {})) {
    if (!currentSlots[slotName]) {
      mergedSlots[slotName] = slotData?.value ?? slotData;
    }
  }

  // 3. Update session with summary, sentiment, slots
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

  // 4. Update item statuses for filled slots
  if (workflow?.id) {
    const { rows: items } = await pool.query(
      `SELECT i.id, i.slot_name 
       FROM aa_workflow_items i
       JOIN aa_workflow_stages s ON i.stage_id = s.id
       WHERE s.workflow_id = $1 AND i.slot_name IS NOT NULL`,
      [workflow.id]
    );

    const itemMap = new Map(items.map((i) => [i.slot_name, i.id]));

    for (const [slotName, slotData] of Object.entries(data.slots || {})) {
      const itemId = itemMap.get(slotName);
      if (!itemId) continue;

      const value = slotData?.value ?? slotData;
      const confidence = slotData?.confidence;

      // Only mark as completed if we have a value and reasonable confidence
      if (value !== null && value !== undefined && (confidence === undefined || confidence >= 0.6)) {
        await pool.query(
          `INSERT INTO aa_workflow_item_status 
           (session_id, item_id, status, extracted_value, confidence_score, completed_at, completed_by, source_transcript)
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
  }

  // 5. Recalculate completion percentage and current stage
  await recalculateCurrentStage(sessionId);
}

/**
 * Check for pending AI handoff data and apply to session
 * Called when starting a new workflow session
 * 
 * @param {string} interactionId - Interaction ID
 * @param {string} sessionId - Workflow session ID
 * @returns {Promise<Object|null>} Applied AI data or null
 */
export async function applyPendingAiHandoff(interactionId, sessionId) {
  const pool = getPostgresPool();
  if (!pool) return null;

  try {
    // Find pending event for this interaction
    const { rows: [event] } = await pool.query(
      `SELECT e.*, w.id as workflow_id, w.insight_slots_id, w.insight_summary_id, w.insight_sentiment_id
       FROM aa_ai_handoff_events e
       LEFT JOIN aa_workflows w ON e.insight_group_id = w.insight_group_id
       WHERE e.interaction_id = $1 AND e.status = 'pending_session'
       ORDER BY e.created_at DESC LIMIT 1`,
      [interactionId]
    );

    if (!event) {
      console.log(`${LOG_PREFIX} No pending AI handoff for interaction: ${interactionId}`);
      return null;
    }

    console.log(`${LOG_PREFIX} Found pending AI handoff event: ${event.id}`);

    // Parse the stored data (prefer processed_slots if available)
    const parsedData = event.processed_slots || parseInsightResults(event.raw_payload, event);

    // Build workflow object for processing
    const workflow = {
      id: event.workflow_id,
      insight_slots_id: event.insight_slots_id,
      insight_summary_id: event.insight_summary_id,
      insight_sentiment_id: event.insight_sentiment_id,
    };

    // Apply the data to the session
    await updateWorkflowSessionWithAiData(pool, sessionId, parsedData, workflow);

    // Mark event as processed
    await pool.query(
      `UPDATE aa_ai_handoff_events 
       SET status = 'processed', workflow_session_id = $2, processed_at = NOW()
       WHERE id = $1`,
      [event.id, sessionId]
    );

    console.log(`${LOG_PREFIX} Applied AI handoff data to session: ${sessionId}`);

    return parsedData;
  } catch (err) {
    console.error(`${LOG_PREFIX} Error applying pending AI handoff:`, err);
    return null;
  }
}

/**
 * Recalculate current_stage_id based on completed items
 * Updates the session's current stage to the first stage with incomplete required items
 * 
 * @param {string} sessionId - Workflow session ID
 */
export async function recalculateCurrentStage(sessionId) {
  const pool = getPostgresPool();
  if (!pool) return;

  try {
    // Get session with workflow info
    const { rows: [session] } = await pool.query(
      `SELECT s.*, w.id as wf_id FROM aa_workflow_sessions s
       JOIN aa_workflows w ON s.workflow_id = w.id
       WHERE s.id = $1`,
      [sessionId]
    );

    if (!session) return;

    // Get all stages with their items and completion status
    const { rows: stages } = await pool.query(
      `SELECT st.id, st.order_index, st.is_required,
              i.id as item_id, i.is_required as item_required,
              COALESCE(stat.status, 'pending') as item_status
       FROM aa_workflow_stages st
       LEFT JOIN aa_workflow_items i ON i.stage_id = st.id
       LEFT JOIN aa_workflow_item_status stat ON stat.item_id = i.id AND stat.session_id = $1
       WHERE st.workflow_id = $2
       ORDER BY st.order_index, i.order_index`,
      [sessionId, session.workflow_id]
    );

    // Group by stage and check completion
    const stageMap = new Map();
    for (const row of stages) {
      if (!stageMap.has(row.id)) {
        stageMap.set(row.id, {
          id: row.id,
          order_index: row.order_index,
          is_required: row.is_required,
          items: [],
        });
      }
      if (row.item_id) {
        stageMap.get(row.id).items.push({
          id: row.item_id,
          is_required: row.item_required,
          status: row.item_status,
        });
      }
    }

    // Find first incomplete stage (has pending required items)
    const sortedStages = Array.from(stageMap.values()).sort((a, b) => a.order_index - b.order_index);
    
    let currentStageId = null;
    let totalItems = 0;
    let completedItems = 0;

    for (const stage of sortedStages) {
      const pendingRequired = stage.items.filter(
        (i) => i.is_required && i.status === "pending"
      );
      
      totalItems += stage.items.length;
      completedItems += stage.items.filter((i) => i.status === "completed").length;

      if (!currentStageId && pendingRequired.length > 0) {
        currentStageId = stage.id;
      }
    }

    // If all stages complete, use the last stage
    if (!currentStageId && sortedStages.length > 0) {
      currentStageId = sortedStages[sortedStages.length - 1].id;
    }

    // Calculate completion percentage
    const percentage = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

    // Update session
    await pool.query(
      `UPDATE aa_workflow_sessions SET 
        current_stage_id = $1, 
        completion_percentage = $2,
        updated_at = NOW()
       WHERE id = $3`,
      [currentStageId, percentage, sessionId]
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} Error recalculating current stage:`, err);
  }
}

/**
 * Get AI context data for an interaction
 * Used by the ai-context endpoint as a polling fallback
 * 
 * @param {string} interactionId - Interaction ID
 * @returns {Promise<Object>} AI context data or status
 */
export async function getAiContextForInteraction(interactionId) {
  const pool = getPostgresPool();
  if (!pool) return { status: "error", message: "Database not available" };

  try {
    // Check if interaction exists and has AI call control ID
    const { rows: [interaction] } = await pool.query(
      `SELECT id, metadata FROM cc_interactions WHERE id = $1`,
      [interactionId]
    );

    if (!interaction) {
      return { status: "error", message: "Interaction not found" };
    }

    const aiCallControlId = interaction.metadata?.ai_call_control_id;
    if (!aiCallControlId) {
      return { status: "not_applicable", message: "No AI assistant was involved in this call" };
    }

    // Check for workflow session with AI data
    const { rows: [session] } = await pool.query(
      `SELECT ai_summary, ai_sentiment, ai_handoff_received_at, ai_handoff_source, slots_filled
       FROM aa_workflow_sessions WHERE interaction_id = $1`,
      [interactionId]
    );

    if (session?.ai_handoff_received_at) {
      return {
        status: "available",
        data: {
          slots_filled: session.slots_filled,
          summary: session.ai_summary,
          sentiment: session.ai_sentiment,
          received_at: session.ai_handoff_received_at,
          source: session.ai_handoff_source,
        },
      };
    }

    // Check for pending handoff event
    const { rows: [event] } = await pool.query(
      `SELECT id, status, created_at FROM aa_ai_handoff_events 
       WHERE interaction_id = $1 
       ORDER BY created_at DESC LIMIT 1`,
      [interactionId]
    );

    if (event?.status === "pending_session") {
      return {
        status: "available",
        data: event.processed_slots || { slots_filled: {} },
        message: "Data available, awaiting session start",
      };
    }

    // No data yet
    return {
      status: "pending",
      message: "Waiting for AI data...",
      ai_call_control_id: aiCallControlId,
    };
  } catch (err) {
    console.error(`${LOG_PREFIX} Error getting AI context:`, err);
    return { status: "error", message: err.message };
  }
}

/**
 * Broadcast AI handoff data to agent via SSE
 * @param {Object} interaction - Interaction object with agent_username
 * @param {string} sessionId - Workflow session ID
 * @param {Object} data - Parsed insight data
 */
export async function broadcastAiHandoffToAgent(interaction, sessionId, data) {
  if (!interaction?.agent_username) return;

  try {
    const { PgDb } = await import("@/lib/pgdb.js");
    const agent = await PgDb.findUserByUsername(interaction.agent_username);
    if (!agent?.id) return;

    // Transform slots for frontend
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
        slots_details: data.slots,
        summary: data.summary,
        sentiment: data.sentiment,
        completed_stages: data.completedStages,
        received_at: new Date().toISOString(),
      },
    };

    await broadcastToKey(`user:status:${agent.id}`, payload);
    await broadcastToKey(`contact-center:agent:${agent.username}`, payload);

    console.log(`${LOG_PREFIX} Broadcasted AI handoff data to agent ${agent.username}`);
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to broadcast to agent:`, err);
  }
}

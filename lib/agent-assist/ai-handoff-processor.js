/**
 * AI Handoff Processor
 * 
 * Handles processing of AI-to-agent workflow handoffs.
 * Processes pending insight events and updates workflow sessions.
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import { broadcastToKey } from "@/lib/sse";
import { agentAssistRuntimePayload, handoffLogger } from "./logging.mjs";

function normalizeConfidenceThreshold(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 1) {
    return 0.95;
  }
  return Math.round(numericValue * 100) / 100;
}

/**
 * Parse insight results from stored event payload
 * @param {Object} insightPayload - Webhook insight data or processed_slots
 * @param {Object} workflow - Workflow with insight IDs
 * @returns {Object} Parsed data with slots, summary, sentiment
 */
function parseInsightResults(insightPayload, workflow) {
  // If we have pre-processed slots, use them directly
  if (insightPayload?.slots && !insightPayload?.data?.payload) {
    return insightPayload;
  }

  const data = {
    slots: {},
    completedStages: [],
    summary: null,
    sentiment: null,
  };

  // Handle both source data and processed_slots formats
  const results = insightPayload?.data?.payload?.results ||
                  insightPayload?.payload?.results ||
                  insightPayload?.results ||
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
        handoffLogger.error("log_prefix_failed_to_parse_slots_result", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
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
  const confidenceThreshold = normalizeConfidenceThreshold(workflow?.llm_confidence_threshold);

  // 2. Merge only trusted AI slots with existing slots (don't overwrite agent-entered data).
  // Low-confidence values are kept on the item as suggestions until the agent confirms/edits them.
  const mergedSlots = { ...currentSlots };
  for (const [slotName, slotData] of Object.entries(data.slots || {})) {
    const confidence = slotData?.confidence;
    const isTrusted = confidence === undefined || confidence >= confidenceThreshold;
    if (!currentSlots[slotName] && isTrusted) {
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

      // Mark trusted AI values as completed; keep low-confidence captures as suggested until an agent confirms/edits.
      if (value !== null && value !== undefined && (confidence === undefined || confidence >= 0.6)) {
        const isTrusted = confidence === undefined || confidence >= confidenceThreshold;
        const nextStatus = isTrusted ? "completed" : "suggested";
        const completedAtSql = isTrusted ? "NOW()" : "NULL";

        await pool.query(
          `INSERT INTO aa_workflow_item_status 
           (session_id, item_id, status, extracted_value, confidence_score, completed_at, completed_by, source_transcript)
           VALUES ($1, $2, $6, $3, $4, ${completedAtSql}, 'ai', $5)
           ON CONFLICT (session_id, item_id) 
           DO UPDATE SET
             status = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.status ELSE $6 END,
             extracted_value = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.extracted_value ELSE $3 END,
             confidence_score = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.confidence_score ELSE $4 END,
             completed_at = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.completed_at ELSE ${completedAtSql} END,
             completed_by = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN 'agent' ELSE 'ai' END,
             source_transcript = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.source_transcript ELSE $5 END,
             updated_at = NOW()`,
          [
            sessionId,
            itemId,
            typeof value === "string" ? value : JSON.stringify(value),
            confidence || null,
            slotData?.source_utterance || null,
            nextStatus,
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
    // Find pending event for this interaction.
    // Use the session's workflow_id directly (reliable) instead of joining via insight_group_id
    // which may not match if insight_group_id is not configured on the workflow.
    const { rows: [event] } = await pool.query(
      `SELECT e.*
       FROM aa_ai_handoff_events e
       WHERE e.interaction_id = $1 AND e.status = 'pending_session'
       ORDER BY e.created_at DESC LIMIT 1`,
      [interactionId]
    );

    if (!event) {
      handoffLogger.info("log_prefix_no_pending_ai_handoff_for_interaction_interactionid", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
      return null;
    }

    handoffLogger.info("log_prefix_found_pending_ai_handoff_event_event_id", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));

    // Get workflow from session (authoritative source — passed as sessionId)
    const { rows: [sessionRow] } = await pool.query(
      `SELECT s.workflow_id, w.insight_slots_id, w.insight_summary_id, w.insight_sentiment_id, w.llm_confidence_threshold
       FROM aa_workflow_sessions s
       JOIN aa_workflows w ON s.workflow_id = w.id
       WHERE s.id = $1`,
      [sessionId]
    );

    // Parse the stored data (prefer processed_slots if available)
    const parsedData = event.processed_slots || parseInsightResults(event.raw_payload, {
      insight_slots_id: sessionRow?.insight_slots_id,
      insight_summary_id: sessionRow?.insight_summary_id,
      insight_sentiment_id: sessionRow?.insight_sentiment_id,
    });

    // Build workflow object using session's workflow (not event's insight_group_id join)
    const workflow = {
      id: sessionRow?.workflow_id || null,
      insight_slots_id: sessionRow?.insight_slots_id,
      insight_summary_id: sessionRow?.insight_summary_id,
      insight_sentiment_id: sessionRow?.insight_sentiment_id,
      llm_confidence_threshold: sessionRow?.llm_confidence_threshold,
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

    handoffLogger.info("log_prefix_applied_ai_handoff_data_to_session_sessionid", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));

    return parsedData;
  } catch (err) {
    handoffLogger.error("log_prefix_error_applying_pending_ai_handoff", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
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

    // Find first incomplete stage (has required items still pending or awaiting agent confirmation)
    const sortedStages = Array.from(stageMap.values()).sort((a, b) => a.order_index - b.order_index);
    
    let currentStageId = null;
    let totalItems = 0;
    let completedItems = 0;

    for (const stage of sortedStages) {
      const incompleteRequired = stage.items.filter(
        (i) => i.is_required && ["pending", "suggested"].includes(i.status)
      );
      
      totalItems += stage.items.length;
      completedItems += stage.items.filter((i) => i.status === "completed").length;

      if (!currentStageId && incompleteRequired.length > 0) {
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
    handoffLogger.error("log_prefix_error_recalculating_current_stage", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
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
    handoffLogger.error("log_prefix_error_getting_ai_context", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
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

    // Transform slots for frontend from the persisted session state, not raw handoff data.
    // The session was already updated with the workflow threshold, so low-confidence slots
    // stay out of slots_filled and remain suggested until the agent confirms or edits them.
    const pool = getPostgresPool();
    let slotsFilled = {};
    let confidenceThreshold = 0.95;
    let statusBySlotName = new Map();

    if (pool && sessionId) {
      const { rows: [sessionRow] } = await pool.query(
        `SELECT s.slots_filled, w.llm_confidence_threshold
         FROM aa_workflow_sessions s
         JOIN aa_workflows w ON s.workflow_id = w.id
         WHERE s.id = $1`,
        [sessionId]
      );
      slotsFilled = sessionRow?.slots_filled || {};
      confidenceThreshold = normalizeConfidenceThreshold(sessionRow?.llm_confidence_threshold);

      const { rows: statusRows } = await pool.query(
        `SELECT i.slot_name,
                st.status,
                st.extracted_value,
                st.confidence_score,
                st.completed_by,
                st.completed_at,
                st.source_transcript
         FROM aa_workflow_item_status st
         JOIN aa_workflow_items i ON i.id = st.item_id
         WHERE st.session_id = $1 AND i.slot_name IS NOT NULL`,
        [sessionId]
      );
      statusBySlotName = new Map(statusRows.map((row) => [row.slot_name, row]));
    } else {
      for (const [key, val] of Object.entries(data.slots || {})) {
        const confidence = val?.confidence;
        if (confidence === undefined || confidence >= confidenceThreshold) {
          slotsFilled[key] = val?.value ?? val;
        }
      }
    }

    const slotsDetails = {};
    for (const [key, val] of Object.entries(data.slots || {})) {
      const statusRow = statusBySlotName.get(key);
      const rawValue = val?.value ?? val;
      slotsDetails[key] = {
        ...(val && typeof val === "object" ? val : { value: rawValue }),
        value: statusRow?.extracted_value ?? rawValue,
        confidence: statusRow?.confidence_score ?? val?.confidence,
        confidence_threshold: confidenceThreshold,
        status: statusRow?.status || (Object.prototype.hasOwnProperty.call(slotsFilled, key) ? "completed" : "suggested"),
        completed_by: statusRow?.completed_by || "ai",
        completed_at: statusRow?.completed_at || null,
        source_utterance: statusRow?.source_transcript ?? val?.source_utterance,
      };
    }

    const payload = {
      type: "ai_handoff_data",
      interactionId: interaction.id,
      sessionId,
      data: {
        slots_filled: slotsFilled,
        slots_details: slotsDetails,
        summary: data.summary,
        sentiment: data.sentiment,
        completed_stages: data.completedStages,
        received_at: new Date().toISOString(),
      },
    };

    await broadcastToKey(`user:status:${agent.id}`, payload);
    await broadcastToKey(`contact-center:agent:${agent.username}`, payload);

    handoffLogger.info("log_prefix_broadcasted_ai_handoff_data_to_agent_agent_username", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
  } catch (err) {
    handoffLogger.error("log_prefix_failed_to_broadcast_to_agent", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
  }
}

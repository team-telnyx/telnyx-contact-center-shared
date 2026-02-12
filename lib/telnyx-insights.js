/**
 * Telnyx Insights API wrapper
 * 
 * Provides functions to manage Insight Groups and Insight Templates
 * for AI-to-agent workflow handoff.
 */

import { buildTelnyxV2Url } from "@/lib/telnyx";
import { getPostgresPool } from "@/lib/postgres.mjs";

/**
 * Get the Telnyx API key from environment
 * @returns {string} API key
 * @throws {Error} If API key is not configured
 */
function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY is not configured");
  }
  return apiKey;
}

/**
 * Make an authenticated request to the Telnyx API with retry logic
 * @param {string} path - API path (without base URL)
 * @param {Object} options - Fetch options
 * @param {number} retries - Number of retries for 5xx errors (default: 3)
 * @returns {Promise<Object>} API response data
 */
async function telnyxRequest(path, options = {}, retries = 3) {
  const apiKey = getApiKey();
  const url = buildTelnyxV2Url(path);
  
  let lastError = null;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
        cache: "no-store",
      });

      const text = await response.text();
      
      if (!response.ok) {
        const error = new Error(`Telnyx API error: ${response.status} ${text}`);
        error.status = response.status;
        error.response = text;
        
        // Retry on 5xx errors (server errors)
        if (response.status >= 500 && attempt < retries) {
          console.log(`[Insights] Retry ${attempt + 1}/${retries} for ${path} (status: ${response.status})`);
          lastError = error;
          // Exponential backoff: 1s, 2s, 4s
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          continue;
        }
        
        throw error;
      }

      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    } catch (fetchError) {
      // Network errors - retry
      if (attempt < retries && !fetchError.status) {
        console.log(`[Insights] Retry ${attempt + 1}/${retries} for ${path} (network error)`);
        lastError = fetchError;
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw fetchError;
    }
  }
  
  throw lastError;
}

// ============ INSIGHT GROUPS ============

/**
 * Create an Insight Group for a workflow
 * @param {string} workflowName - Name of the workflow
 * @param {string} webhookUrl - Webhook URL for insight delivery
 * @returns {Promise<Object>} Created insight group
 */
export async function createInsightGroup(workflowName, webhookUrl) {
  console.log(`[Insights] Creating insight group for workflow: ${workflowName}`);
  
  const data = await telnyxRequest("/ai/conversations/insight-groups", {
    method: "POST",
    body: JSON.stringify({
      name: `WF: ${workflowName}`,
      webhook: webhookUrl,
    }),
  });

  console.log(`[Insights] Created insight group: ${data?.data?.id}`);
  return data?.data || data;
}

/**
 * Update an Insight Group
 * @param {string} groupId - Insight group ID
 * @param {Object} updates - Fields to update (name, webhook)
 * @returns {Promise<Object>} Updated insight group
 */
export async function updateInsightGroup(groupId, updates) {
  console.log(`[Insights] Updating insight group: ${groupId}`);
  
  const data = await telnyxRequest(
    `/ai/conversations/insight-groups/${encodeURIComponent(groupId)}`,
    {
      method: "PUT",
      body: JSON.stringify(updates),
    }
  );

  return data?.data || data;
}

/**
 * Delete an Insight Group
 * @param {string} groupId - Insight group ID
 * @returns {Promise<boolean>} True if deleted
 */
export async function deleteInsightGroup(groupId) {
  console.log(`[Insights] Deleting insight group: ${groupId}`);
  
  try {
    await telnyxRequest(
      `/ai/conversations/insight-groups/${encodeURIComponent(groupId)}`,
      { method: "DELETE" }
    );
    return true;
  } catch (err) {
    if (err.status === 404) {
      console.log(`[Insights] Insight group ${groupId} already deleted`);
      return true;
    }
    throw err;
  }
}

/**
 * Get an Insight Group by ID
 * @param {string} groupId - Insight group ID
 * @returns {Promise<Object|null>} Insight group or null if not found
 */
export async function getInsightGroup(groupId) {
  try {
    const data = await telnyxRequest(
      `/ai/conversations/insight-groups/${encodeURIComponent(groupId)}`,
      { method: "GET" }
    );
    return data?.data || data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// ============ INSIGHT TEMPLATES ============

/**
 * Create an Insight Template
 * @param {Object} config - Insight configuration
 * @param {string} config.name - Insight name
 * @param {string} config.instructions - Extraction instructions
 * @param {Object} [config.json_schema] - JSON schema for structured output
 * @returns {Promise<Object>} Created insight
 */
export async function createInsight({ name, instructions, json_schema }) {
  console.log(`[Insights] Creating insight: ${name}`);
  
  const payload = {
    name,
    instructions,
  };

  if (json_schema) {
    payload.json_schema = json_schema;
  }

  const data = await telnyxRequest("/ai/conversations/insights", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  console.log(`[Insights] Created insight: ${data?.data?.id}`);
  return data?.data || data;
}

/**
 * Update an Insight Template
 * @param {string} insightId - Insight ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated insight
 */
export async function updateInsight(insightId, updates) {
  console.log(`[Insights] Updating insight: ${insightId}`);
  
  const data = await telnyxRequest(
    `/ai/conversations/insights/${encodeURIComponent(insightId)}`,
    {
      method: "PUT",
      body: JSON.stringify(updates),
    }
  );

  return data?.data || data;
}

/**
 * Delete an Insight Template
 * @param {string} insightId - Insight ID
 * @returns {Promise<boolean>} True if deleted
 */
export async function deleteInsight(insightId) {
  console.log(`[Insights] Deleting insight: ${insightId}`);
  
  try {
    await telnyxRequest(
      `/ai/conversations/insights/${encodeURIComponent(insightId)}`,
      { method: "DELETE" }
    );
    return true;
  } catch (err) {
    if (err.status === 404) {
      console.log(`[Insights] Insight ${insightId} already deleted`);
      return true;
    }
    throw err;
  }
}

/**
 * Get an Insight Template by ID
 * @param {string} insightId - Insight ID
 * @returns {Promise<Object|null>} Insight or null if not found
 */
export async function getInsight(insightId) {
  try {
    const data = await telnyxRequest(
      `/ai/conversations/insights/${encodeURIComponent(insightId)}`,
      { method: "GET" }
    );
    return data?.data || data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// ============ GROUP ASSIGNMENTS ============

/**
 * Assign an insight to a group
 * @param {string} insightId - Insight ID
 * @param {string} groupId - Insight group ID
 * @returns {Promise<boolean>} True if assigned
 */
export async function assignInsightToGroup(insightId, groupId) {
  console.log(`[Insights] Assigning insight ${insightId} to group ${groupId}`);
  
  await telnyxRequest(
    `/ai/conversations/insight-groups/${encodeURIComponent(groupId)}/insights/${encodeURIComponent(insightId)}/assign`,
    { method: "POST" }
  );

  return true;
}

/**
 * Unassign an insight from a group
 * @param {string} insightId - Insight ID
 * @param {string} groupId - Insight group ID
 * @returns {Promise<boolean>} True if unassigned
 */
export async function unassignInsightFromGroup(insightId, groupId) {
  console.log(`[Insights] Unassigning insight ${insightId} from group ${groupId}`);
  
  try {
    await telnyxRequest(
      `/ai/conversations/insight-groups/${encodeURIComponent(groupId)}/insights/${encodeURIComponent(insightId)}/unassign`,
      { method: "POST" }
    );
    return true;
  } catch (err) {
    if (err.status === 404) return true;
    throw err;
  }
}

// ============ HIGH-LEVEL OPERATIONS ============

/**
 * Create or update an insight, handling upsert logic
 * @param {string|null} existingId - Existing insight ID (if updating)
 * @param {Object} config - Insight configuration
 * @returns {Promise<Object>} Created or updated insight
 */
async function upsertInsight(existingId, config) {
  if (existingId) {
    // Check if insight still exists
    const existing = await getInsight(existingId);
    if (existing) {
      // Update existing insight
      return updateInsight(existingId, config);
    }
  }
  // Create new insight
  return createInsight(config);
}

/**
 * Ensure an insight is assigned to a group
 * @param {string} insightId - Insight ID
 * @param {string} groupId - Group ID
 */
async function ensureInsightInGroup(insightId, groupId) {
  try {
    await assignInsightToGroup(insightId, groupId);
  } catch (err) {
    // May already be assigned - that's ok
    if (!err.response?.includes("already assigned")) {
      console.warn(`[Insights] Warning assigning insight to group:`, err.message);
    }
  }
}

/**
 * Sync all insights for a workflow
 * Creates or updates the insight group and 3 insight templates (slots, summary, sentiment)
 * 
 * @param {Object} workflow - Workflow object with stages and items
 * @param {string} webhookUrl - Webhook URL for insight delivery
 * @returns {Promise<Object>} Object with groupId, slotsInsightId, summaryInsightId, sentimentInsightId
 */
export async function syncWorkflowInsights(workflow, webhookUrl) {
  // Import schema generators
  const {
    generateSlotsSchema,
    generateSlotsInstructions,
    generateSummaryInstructions,
    generateSentimentInstructions,
  } = await import("@/lib/agent-assist/insight-schema-generator");

  console.log(`[Insights] Syncing insights for workflow: ${workflow.name}`);

  // 1. Create or get insight group
  let groupId = workflow.insight_group_id;
  if (!groupId) {
    const group = await createInsightGroup(workflow.name, webhookUrl);
    groupId = group.id;
  } else {
    // Verify group still exists, update webhook if needed
    const existing = await getInsightGroup(groupId);
    if (!existing) {
      console.log(`[Insights] Group ${groupId} not found, creating new one`);
      const group = await createInsightGroup(workflow.name, webhookUrl);
      groupId = group.id;
    } else if (existing.webhook !== webhookUrl) {
      await updateInsightGroup(groupId, { webhook: webhookUrl });
    }
  }

  // 2. Collect all slots from workflow stages
  const allSlots = [];
  const stages = workflow.stages || [];
  for (const stage of stages) {
    const items = stage.items || [];
    for (const item of items) {
      if (item.type === "slot" && item.slot_name) {
        allSlots.push({
          slot_name: item.slot_name,
          slot_type: item.slot_type || "text",
          label: item.label,
          description: item.description,
          hints: item.hints || [],
          slot_options: item.slot_options,
          slot_validation: item.slot_validation,
        });
      }
    }
  }

  // 3. Generate schemas and instructions
  const slotsSchema = generateSlotsSchema(allSlots);
  const slotsInstructions = generateSlotsInstructions(workflow, stages);
  const summaryInstructions = generateSummaryInstructions(workflow);
  const sentimentInstructions = generateSentimentInstructions(workflow);

  // 4. Create/update each insight
  const slotsInsight = await upsertInsight(workflow.insight_slots_id, {
    name: `${workflow.name} - Slots`,
    instructions: slotsInstructions,
    json_schema: slotsSchema,
  });

  const summaryInsight = await upsertInsight(workflow.insight_summary_id, {
    name: `${workflow.name} - Summary`,
    instructions: summaryInstructions,
  });

  const sentimentInsight = await upsertInsight(workflow.insight_sentiment_id, {
    name: `${workflow.name} - Sentiment`,
    instructions: sentimentInstructions,
  });

  // 5. Ensure all are assigned to group
  await ensureInsightInGroup(slotsInsight.id, groupId);
  await ensureInsightInGroup(summaryInsight.id, groupId);
  await ensureInsightInGroup(sentimentInsight.id, groupId);

  const result = {
    groupId,
    slotsInsightId: slotsInsight.id,
    summaryInsightId: summaryInsight.id,
    sentimentInsightId: sentimentInsight.id,
  };

  console.log(`[Insights] Sync complete for workflow ${workflow.name}:`, result);
  return result;
}

/**
 * Get insights for a conversation (polling fallback)
 * @param {string} conversationId - AI conversation ID
 * @returns {Promise<Array>} Array of insight results
 */
export async function getConversationInsights(conversationId) {
  console.log(`[Insights] Fetching insights for conversation: ${conversationId}`);
  
  const data = await telnyxRequest(
    `/ai/conversations/${encodeURIComponent(conversationId)}/conversations-insights`,
    { method: "GET" }
  );

  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Clean up all insights when a workflow is deleted
 * @param {Object} workflow - Workflow object with insight IDs
 * @returns {Promise<void>}
 */
export async function deleteWorkflowInsights(workflow) {
  console.log(`[Insights] Deleting insights for workflow: ${workflow.name || workflow.id}`);

  const errors = [];

  // Delete insights first (must unassign from group or delete will fail)
  if (workflow.insight_slots_id) {
    try {
      if (workflow.insight_group_id) {
        await unassignInsightFromGroup(workflow.insight_slots_id, workflow.insight_group_id);
      }
      await deleteInsight(workflow.insight_slots_id);
    } catch (err) {
      errors.push({ type: "slots", error: err.message });
    }
  }

  if (workflow.insight_summary_id) {
    try {
      if (workflow.insight_group_id) {
        await unassignInsightFromGroup(workflow.insight_summary_id, workflow.insight_group_id);
      }
      await deleteInsight(workflow.insight_summary_id);
    } catch (err) {
      errors.push({ type: "summary", error: err.message });
    }
  }

  if (workflow.insight_sentiment_id) {
    try {
      if (workflow.insight_group_id) {
        await unassignInsightFromGroup(workflow.insight_sentiment_id, workflow.insight_group_id);
      }
      await deleteInsight(workflow.insight_sentiment_id);
    } catch (err) {
      errors.push({ type: "sentiment", error: err.message });
    }
  }

  // Delete group last
  if (workflow.insight_group_id) {
    try {
      await deleteInsightGroup(workflow.insight_group_id);
    } catch (err) {
      errors.push({ type: "group", error: err.message });
    }
  }

  if (errors.length > 0) {
    console.warn(`[Insights] Some deletions failed:`, errors);
  }

  console.log(`[Insights] Cleanup complete for workflow: ${workflow.name || workflow.id}`);
}

/**
 * Find workflow by insight group ID
 * @param {string} insightGroupId - Insight group ID
 * @returns {Promise<Object|null>} Workflow or null
 */
export async function findWorkflowByInsightGroup(insightGroupId) {
  const pool = getPostgresPool();
  if (!pool) return null;

  const { rows: [workflow] } = await pool.query(
    `SELECT w.*, 
            json_agg(
              json_build_object(
                'id', s.id,
                'name', s.name,
                'order_index', s.order_index,
                'items', (
                  SELECT json_agg(
                    json_build_object(
                      'id', i.id,
                      'type', i.type,
                      'label', i.label,
                      'slot_name', i.slot_name,
                      'slot_type', i.slot_type,
                      'description', i.description,
                      'hints', i.hints,
                      'order_index', i.order_index
                    ) ORDER BY i.order_index
                  )
                  FROM aa_workflow_items i
                  WHERE i.stage_id = s.id
                )
              ) ORDER BY s.order_index
            ) AS stages
     FROM aa_workflows w
     LEFT JOIN aa_workflow_stages s ON s.workflow_id = w.id
     WHERE w.insight_group_id = $1
     GROUP BY w.id`,
    [insightGroupId]
  );

  return workflow || null;
}

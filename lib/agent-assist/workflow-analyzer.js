/**
 * Workflow Analyzer
 * 
 * Uses Telnyx AI chat completion with GPT-4o to analyze transcripts
 * and detect workflow item completion and slot extraction.
 */

import {
  buildWorkflowAnalysisSystemPrompt,
  buildWorkflowAnalysisUserPrompt,
} from "./workflow-prompts";
import { agentAssistRuntimePayload, llmLogger } from "./logging.mjs";
import { getPostgresPool } from "@/lib/postgres.mjs";

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const DEFAULT_WORKFLOW_LLM_MODEL = "openai/gpt-4o";
const DEFAULT_FALLBACK_MODEL = process.env.AGENT_ASSIST_WORKFLOW_FALLBACK_MODEL || "openai/gpt-5.6-luna";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_TOTAL_TIMEOUT_MS = 12000;

function workflowTimeoutMs() {
  const configured = Number(process.env.AGENT_ASSIST_WORKFLOW_LLM_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 1000
    ? Math.round(configured)
    : DEFAULT_TIMEOUT_MS;
}

function workflowTotalTimeoutMs() {
  const configured = Number(process.env.AGENT_ASSIST_WORKFLOW_TOTAL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 2000
    ? Math.round(configured)
    : DEFAULT_TOTAL_TIMEOUT_MS;
}

function createAttemptSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(externalSignal?.reason || new Error("Workflow analysis cancelled"));
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });

  const timer = setTimeout(
    () => controller.abort(new Error(`Workflow analysis timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function parseJsonResponse(rawContent) {
  if (!rawContent || typeof rawContent !== "string") {
    throw new Error("Workflow analyzer returned no response content");
  }
  const content = rawContent
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    return JSON.parse(content);
  } catch (initialError) {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw initialError;
    return JSON.parse(jsonMatch[0]);
  }
}

/**
 * MCP output mappings are the source of truth for slot ownership.
 *
 * A slot named on the left side of `outputs`, an explicit alternatives target,
 * or the owning control slot of on_result/on_complete/manual_submit is
 * machine-derived. The conversation LLM must be able to READ those values from
 * `slotsFilled`, but it must never independently extract/write the same slot.
 * Manual agent edits remain allowed by the normal slot-edit routes.
 */
async function excludeMcpOwnedItems(pendingItems, workflowId) {
  if (!workflowId || !Array.isArray(pendingItems) || pendingItems.length === 0) return pendingItems;
  const pool = getPostgresPool();
  if (!pool) return pendingItems;

  try {
    const { rows } = await pool.query(
      `WITH bound AS (
         SELECT i.slot_name AS owner_slot, i.mcp_binding
           FROM aa_workflow_items i
           JOIN aa_workflow_stages s ON s.id = i.stage_id
          WHERE s.workflow_id = $1
            AND i.mcp_binding IS NOT NULL
       ), derived AS (
         SELECT jsonb_object_keys(COALESCE(mcp_binding -> 'outputs', '{}'::jsonb)) AS slot_name
           FROM bound
         UNION
         SELECT NULLIF(BTRIM(COALESCE(mcp_binding -> 'alternatives' ->> 'target_slot', '')), '') AS slot_name
           FROM bound
         UNION
         SELECT NULLIF(BTRIM(COALESCE(owner_slot, '')), '') AS slot_name
           FROM bound
          WHERE COALESCE(mcp_binding ->> 'trigger', 'on_fill') IN ('on_result', 'on_complete', 'manual_submit')
       )
       SELECT DISTINCT slot_name
         FROM derived
        WHERE slot_name IS NOT NULL`,
      [workflowId],
    );
    const mcpOwnedSlots = new Set(rows.map((row) => row.slot_name).filter(Boolean));
    if (mcpOwnedSlots.size === 0) return pendingItems;
    return pendingItems.filter(
      (item) => item?.type !== "slot" || !item.slot_name || !mcpOwnedSlots.has(item.slot_name),
    );
  } catch (error) {
    // The workflow already depends on Postgres; this is defensive fail-open
    // behavior for tests/migrations rather than a reason to fail the call.
    llmLogger.warn("workflow_analyzer_mcp_ownership_filter_failed", agentAssistRuntimePayload({
      workflowId,
      error,
    }));
    return pendingItems;
  }
}

async function requestAnalysis({
  model,
  messages,
  maxTokens,
  reasoningEnabled,
  signal,
  observabilityContext,
  timeoutMs,
}) {
  const startedAt = Date.now();
  const attemptSignal = createAttemptSignal(signal, timeoutMs);
  try {
    const response = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      signal: attemptSignal.signal,
      body: JSON.stringify({
        messages,
        model,
        temperature: 0.3,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        // Always send this field. Kimi/GLM-capable serving paths may otherwise
        // opt into reasoning by default, while externally hosted GPT models can
        // simply honor the explicit false value for this extraction workload.
        enable_thinking: reasoningEnabled === true,
      }),
    });

    const providerRequestId =
      response.headers.get("x-request-id") ||
      response.headers.get("request-id") ||
      response.headers.get("telnyx-request-id") ||
      undefined;
    if (!response.ok) {
      const providerErrorSummary = (await response.text()).slice(0, 500);
      const error = new Error(`Workflow analyzer HTTP ${response.status}: ${providerErrorSummary}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    const rawContent =
      data.choices?.[0]?.message?.content ||
      data.choices?.[0]?.message?.reasoning ||
      null;
    const analysis = parseJsonResponse(rawContent);
    llmLogger.info("workflow_analyzer_request_completed", agentAssistRuntimePayload({
      ...observabilityContext,
      provider: "telnyx",
      model,
      reasoningEnabled: reasoningEnabled === true,
      maxTokens,
      durationMs: Date.now() - startedAt,
      providerRequestId: providerRequestId || data.id,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    }));
    return analysis;
  } catch (error) {
    llmLogger.warn("workflow_analyzer_request_failed", agentAssistRuntimePayload({
      ...observabilityContext,
      error,
      provider: "telnyx",
      model,
      reasoningEnabled: reasoningEnabled === true,
      maxTokens,
      durationMs: Date.now() - startedAt,
    }));
    throw error;
  } finally {
    attemptSignal.cleanup();
  }
}

/**
 * Analyze a transcript for workflow item completion
 * @param {Object} options - Analysis options
 * @param {string} options.transcript - The transcript text to analyze
 * @param {string} options.speaker - Speaker identifier (inbound/outbound/customer/agent)
 * @param {Array} options.pendingItems - Array of pending workflow items to check
 * @param {Object} options.slotsFilled - Already filled slots
 * @param {string} [options.model] - AI model to use (e.g. from workflow llm_model), defaults to the workflow LLM default
 * @returns {Promise<Object>} Analysis results
 */
export async function analyzeWorkflowTranscript({
  transcript,
  speaker,
  pendingItems,
  slotsFilled = {},
  model = DEFAULT_WORKFLOW_LLM_MODEL,
  fallbackModel = DEFAULT_FALLBACK_MODEL,
  reasoningEnabled = false,
  maxOutputTokens = 1200,
  confidenceThreshold = 0.95,
  currentTarget = null,
  currentStageName = null,
  isReadBackStage = false,
  allowCorrections = false,
  correctionInProgress = false,
  recentContext = [],
  bleedGuardSlot = null,
  signal,
  observabilityContext = {},
}) {
  if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
    return getDefaultResult();
  }

  if (!pendingItems || pendingItems.length === 0) {
    return getDefaultResult();
  }

  try {
    const analyzerItems = await excludeMcpOwnedItems(pendingItems, observabilityContext?.workflowId);
    if (analyzerItems.length === 0) return getDefaultResult();

    const systemPrompt = buildWorkflowAnalysisSystemPrompt({
      pendingItems: analyzerItems,
      // Deliberately unchanged: MCP-derived fields stay visible in the complete
      // slot context so the LLM can reason from them while filling LLM-owned
      // fields, and later MCP bindings can resolve {{slots.x}} from them.
      slotsFilled,
      confidenceThreshold,
      currentTarget,
      currentStageName,
      isReadBackStage,
      allowCorrections,
      correctionInProgress,
      bleedGuardSlot,
    });

    const userPrompt = buildWorkflowAnalysisUserPrompt({
      transcript,
      speaker,
      recentContext,
    });

    // Slot extraction normally returns only a handful of changed items. Bound
    // output so verbose/reasoning-capable models cannot spend tens of seconds
    // filling a multi-thousand-token allowance, while retaining enough room for
    // a multi-slot data dump and low-confidence alternatives.
    const slotCount = analyzerItems.filter((i) => i?.type === "slot").length;
    const itemCount = analyzerItems.length;
    const outputCap = Number.isInteger(maxOutputTokens) && maxOutputTokens >= 512 && maxOutputTokens <= 1200
      ? maxOutputTokens
      : 1200;
    const maxTokens = Math.min(outputCap, Math.max(512, 300 + itemCount * 50 + slotCount * 50));
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const primaryModel = model || DEFAULT_WORKFLOW_LLM_MODEL;
    const models = [primaryModel];
    const configuredFallbackModel = typeof fallbackModel === "string" ? fallbackModel.trim() : "";
    if (configuredFallbackModel && configuredFallbackModel !== primaryModel) {
      models.push(configuredFallbackModel);
    }

    let lastError;
    const deadline = Date.now() + workflowTotalTimeoutMs();
    for (const [attemptIndex, attemptModel] of models.entries()) {
      if (signal?.aborted) break;
      const remainingMs = deadline - Date.now();
      if (remainingMs < 500) break;
      try {
        const analysis = await requestAnalysis({
          model: attemptModel,
          messages,
          maxTokens,
          reasoningEnabled,
          signal,
          timeoutMs: Math.min(workflowTimeoutMs(), remainingMs),
          observabilityContext: {
            ...observabilityContext,
            attempt: attemptIndex + 1,
            fallback: attemptIndex > 0,
            promptCharacters: systemPrompt.length + userPrompt.length,
            pendingItemCount: itemCount,
            pendingSlotCount: slotCount,
          },
        });
        return normalizeAnalysisResult(analysis, analyzerItems);
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return getDefaultResult();
  } catch (error) {
    if (!signal?.aborted) {
      llmLogger.error("workflow_analyzer_failed", agentAssistRuntimePayload({
        ...observabilityContext,
        error,
        provider: "telnyx",
      }));
    }
    return getDefaultResult();
  }
}

/**
 * Analyze multiple transcripts in batch
 * @param {Object} options - Analysis options
 * @param {Array} options.transcripts - Array of {transcript, speaker, timestamp} objects
 * @param {Array} options.pendingItems - Array of pending workflow items
 * @param {Object} options.slotsFilled - Already filled slots
 * @returns {Promise<Object>} Combined analysis results
 */
export async function analyzeWorkflowTranscriptBatch({
  transcripts,
  pendingItems,
  slotsFilled = {},
  model = DEFAULT_WORKFLOW_LLM_MODEL,
  fallbackModel = DEFAULT_FALLBACK_MODEL,
  reasoningEnabled = false,
  maxOutputTokens = 1200,
  signal,
}) {
  if (!transcripts || transcripts.length === 0) {
    return getDefaultResult();
  }

  // For small batches, analyze individually and combine
  if (transcripts.length <= 3) {
    const results = await Promise.all(
      transcripts.map((t) =>
        analyzeWorkflowTranscript({
          transcript: t.transcript,
          speaker: t.speaker,
          pendingItems,
          slotsFilled,
          model,
          fallbackModel,
          reasoningEnabled,
          maxOutputTokens,
          signal,
        })
      )
    );

    // Combine results, keeping unique completed items
    const completedItemsMap = new Map();
    for (const result of results) {
      for (const item of result.completed_items) {
        const existing = completedItemsMap.get(item.item_id);
        if (!existing || existing.confidence < item.confidence) {
          completedItemsMap.set(item.item_id, item);
        }
      }
    }

    return {
      completed_items: Array.from(completedItemsMap.values()),
    };
  }

  // For larger batches, use combined prompt (future enhancement)
  // For now, just analyze last few transcripts
  const recentTranscripts = transcripts.slice(-3);
  return analyzeWorkflowTranscriptBatch({
    transcripts: recentTranscripts,
    pendingItems,
    slotsFilled,
    model,
    fallbackModel,
    reasoningEnabled,
    maxOutputTokens,
    signal,
  });
}

/**
 * Get default result when analysis fails
 */
function getDefaultResult() {
  return {
    completed_items: [],
  };
}

function hasMeaningfulExtractedValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/**
 * Normalize and validate analysis result
 * @param {Object} analysis - Raw analysis from LLM
 * @param {Array} pendingItems - Valid pending items
 * @returns {Object} Normalized result
 */
function normalizeAnalysisResult(analysis, pendingItems) {
  const validItemsById = new Map(pendingItems.map((i) => [i.item_id, i]));
  
  // Filter and validate completed items
  const completedItems = (analysis.completed_items || [])
    .filter((item) => {
      const pendingItem = validItemsById.get(item.item_id);
      if (!item.item_id || !pendingItem) {
        return false;
      }
      const rawConfidence = item.confidence;
      if (
        (typeof rawConfidence !== "number" && typeof rawConfidence !== "string") ||
        (typeof rawConfidence === "string" && rawConfidence.trim() === "")
      ) {
        return false;
      }
      const confidence = Number(rawConfidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return false;
      }
      if (pendingItem.type === "slot" && !hasMeaningfulExtractedValue(item.extracted_value)) {
        return false;
      }
      item.confidence = confidence;
      return true;
    })
    .map((item) => ({
      item_id: item.item_id,
      confidence: Math.min(1, Math.max(0, item.confidence)),
      // Nullish (not falsy) coalescing so boolean false and numeric 0 survive —
      // e.g. "No other aircraft responding" -> false must not become null.
      extracted_value: item.extracted_value ?? null,
      source_text: item.source_text || null,
      // Pass through low-confidence alternatives ({value, confidence}) so the
      // live path can offer agent-confirmation chips, not just the insights path.
      alternatives: Array.isArray(item.alternatives)
        ? item.alternatives
            .filter((a) => a && a.value !== undefined && a.value !== null && a.value !== "")
            .map((a) => ({ value: a.value, confidence: typeof a.confidence === "number" ? a.confidence : null }))
        : [],
    }));

  return {
    completed_items: completedItems,
  };
}

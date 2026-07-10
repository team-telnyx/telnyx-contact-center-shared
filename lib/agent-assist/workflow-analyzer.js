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

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const DEFAULT_WORKFLOW_LLM_MODEL = "openai/gpt-4o";

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
  includeIntent = false,
  includeSentiment = false,
  confidenceThreshold = 0.95,
  currentTarget = null,
  recentContext = [],
}) {
  if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
    return getDefaultResult({ includeIntent, includeSentiment });
  }

  if (!pendingItems || pendingItems.length === 0) {
    return getDefaultResult({ includeIntent, includeSentiment });
  }

  try {
    const systemPrompt = buildWorkflowAnalysisSystemPrompt({
      pendingItems,
      slotsFilled,
      includeIntent,
      includeSentiment,
      confidenceThreshold,
      currentTarget,
    });

    const userPrompt = buildWorkflowAnalysisUserPrompt({
      transcript,
      speaker,
      recentContext,
    });

    // Token budget must scale with the number of pending items: each returned
    // slot now also carries 2-3 alternative {value, confidence} objects, and the
    // live route can send up to MAX_ANALYZER_PENDING_ITEMS (40) items. Too small a
    // cap truncates the JSON, and the parser then falls back to an empty result —
    // losing ALL captures for the utterance, not just the chips.
    //
    // Each low-confidence slot needs 2-3 alternatives (~80 tokens each), so the
    // per-item budget scales with pending item/slot count. Ceiling is 8000 to fit
    // the widened 40-item window: a single "data dump" utterance can fill many
    // slots at once, and if the JSON is truncated the parser falls back to an
    // empty result and loses ALL captures for that utterance. 8000 is verified
    // safe on the models in use (haiku-4.5, gpt-4o tiers all allow >=8k output —
    // the analyze call returns 200, not 400). If a model with a smaller output
    // cap is ever configured, lower this per-tier rather than globally.
    const slotCount = Array.isArray(pendingItems) ? pendingItems.filter((i) => i?.type === "slot").length : 0;
    const itemCount = Array.isArray(pendingItems) ? pendingItems.length : 0;
    const maxTokens = Math.min(
      8000,
      600 + itemCount * 150 + slotCount * 100 + (includeIntent || includeSentiment ? 400 : 0)
    );

    const response = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        model: model || DEFAULT_WORKFLOW_LLM_MODEL,
        temperature: 0.3,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const providerErrorSummary = await response.text();
      llmLogger.error("workflowanalyzer", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
      return getDefaultResult({ includeIntent, includeSentiment });
    }

    const data = await response.json();
    // Some reasoning models put the answer in `reasoning` instead of `content`
    // when response_format: json_object is used. Fall back to reasoning.
    const rawContent =
      data.choices?.[0]?.message?.content ||
      data.choices?.[0]?.message?.reasoning ||
      null;

    if (!rawContent) {
      llmLogger.error("workflowanalyzer", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
      return getDefaultResult({ includeIntent, includeSentiment });
    }

    // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
    const content = rawContent
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    // Parse JSON response
    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch (parseError) {
      // Try to extract JSON object from the string as last resort
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          analysis = JSON.parse(jsonMatch[0]);
        } catch {
          llmLogger.error("workflowanalyzer", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
          return getDefaultResult({ includeIntent, includeSentiment });
        }
      } else {
        llmLogger.error("workflowanalyzer", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
        return getDefaultResult({ includeIntent, includeSentiment });
      }
    }

    // Validate and normalize response
    return normalizeAnalysisResult(analysis, pendingItems, {
      includeIntent,
      includeSentiment,
    });
  } catch (error) {
    llmLogger.error("workflowanalyzer", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    return getDefaultResult({ includeIntent, includeSentiment });
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
  includeIntent = false,
  includeSentiment = false,
}) {
  if (!transcripts || transcripts.length === 0) {
    return getDefaultResult({ includeIntent, includeSentiment });
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
          includeIntent,
          includeSentiment,
        })
      )
    );

    // Combine results, keeping unique completed items
    const completedItemsMap = new Map();
    let lastIntent = "unknown";
    let lastSentiment = "neutral";
    let sentimentScores = [];

    for (const result of results) {
      for (const item of result.completed_items) {
        const existing = completedItemsMap.get(item.item_id);
        if (!existing || existing.confidence < item.confidence) {
          completedItemsMap.set(item.item_id, item);
        }
      }
      if (result.detected_intent !== "unknown") {
        lastIntent = result.detected_intent;
      }
      if (result.sentiment) {
        lastSentiment = result.sentiment;
      }
      if (typeof result.sentiment_score === "number") {
        sentimentScores.push(result.sentiment_score);
      }
    }

    const avgSentimentScore = sentimentScores.length > 0
      ? Math.round(sentimentScores.reduce((a, b) => a + b, 0) / sentimentScores.length)
      : 50;

    return {
      completed_items: Array.from(completedItemsMap.values()),
      ...(includeIntent ? { detected_intent: lastIntent } : {}),
      ...(includeSentiment ? {
        sentiment: lastSentiment,
        sentiment_score: avgSentimentScore,
      } : {}),
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
    includeIntent,
    includeSentiment,
  });
}

/**
 * Get default result when analysis fails
 */
function getDefaultResult({ includeIntent = false, includeSentiment = false } = {}) {
  return {
    completed_items: [],
    ...(includeIntent ? { detected_intent: "unknown" } : {}),
    ...(includeSentiment ? {
      sentiment: "neutral",
      sentiment_score: 50,
    } : {}),
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
function normalizeAnalysisResult(analysis, pendingItems, {
  includeIntent = false,
  includeSentiment = false,
} = {}) {
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

  let sentiment = null;
  let sentimentScore = null;
  if (includeSentiment) {
    sentiment = (analysis.sentiment || "neutral").toLowerCase();
    if (!["positive", "neutral", "negative"].includes(sentiment)) {
      sentiment = "neutral";
    }

    sentimentScore = analysis.sentiment_score;
    if (typeof sentimentScore !== "number") {
      sentimentScore = sentiment === "positive" ? 70 : sentiment === "negative" ? 30 : 50;
    }
    sentimentScore = Math.min(100, Math.max(0, Math.round(sentimentScore)));
  }

  return {
    completed_items: completedItems,
    ...(includeIntent ? { detected_intent: analysis.detected_intent || "unknown" } : {}),
    ...(includeSentiment ? {
      sentiment,
      sentiment_score: sentimentScore,
    } : {}),
  };
}

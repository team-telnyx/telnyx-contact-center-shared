/**
 * Workflow Analyzer
 * 
 * Uses Telnyx AI chat completion with GPT-4o to analyze transcripts
 * and detect workflow item completion and slot extraction.
 */

import {
  buildBatchAnalysisPrompt,
  buildWorkflowAnalysisSystemPrompt,
  buildWorkflowAnalysisUserPrompt,
} from "./workflow-prompts.js";

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";

/**
 * Analyze a transcript for workflow item completion
 * @param {Object} options - Analysis options
 * @param {string} options.transcript - The transcript text to analyze
 * @param {string} options.speaker - Speaker identifier (inbound/outbound/customer/agent)
 * @param {Array} options.pendingItems - Array of pending workflow items to check
 * @param {Object} options.slotsFilled - Already filled slots
 * @param {string} [options.model] - AI model to use (e.g. from workflow llm_model), defaults to moonshotai/Kimi-K2.5
 * @returns {Promise<Object>} Analysis results
 */
export async function analyzeWorkflowTranscript({
  transcript,
  speaker,
  pendingItems,
  slotsFilled = {},
  model = "moonshotai/Kimi-K2.5",
  includeIntent = false,
  includeSentiment = false,
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
    });

    const userPrompt = buildWorkflowAnalysisUserPrompt({
      transcript,
      speaker,
    });

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
        model: model || "moonshotai/Kimi-K2.5",
        temperature: 0,
        max_tokens: includeIntent || includeSentiment ? 1400 : 1200,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[WorkflowAnalyzer] API error:", response.status, errorText);
      return getDefaultResult({ includeIntent, includeSentiment });
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    const analysis = parseWorkflowAnalysisMessage(message, "WorkflowAnalyzer");

    if (!analysis) {
      console.error("[WorkflowAnalyzer] No parseable JSON in response", JSON.stringify(message));
      return getDefaultResult({ includeIntent, includeSentiment });
    }

    // Validate and normalize response
    return normalizeAnalysisResult(analysis, pendingItems, {
      includeIntent,
      includeSentiment,
    });
  } catch (error) {
    console.error("[WorkflowAnalyzer] Error:", error);
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
  model = "moonshotai/Kimi-K2.5",
  includeIntent = false,
  includeSentiment = false,
}) {
  if (!transcripts || transcripts.length === 0) {
    return getDefaultResult({ includeIntent, includeSentiment });
  }

  if (!pendingItems || pendingItems.length === 0) {
    return getDefaultResult({ includeIntent, includeSentiment });
  }

  const normalizedTranscripts = transcripts
    .map((t) => ({
      transcript: typeof t?.transcript === "string" ? t.transcript.trim() : "",
      speaker: t?.speaker || "unknown",
      timestamp: t?.timestamp || null,
    }))
    .filter((t) => t.transcript)
    .slice(-8);

  if (normalizedTranscripts.length === 0) {
    return getDefaultResult({ includeIntent, includeSentiment });
  }

  if (normalizedTranscripts.length === 1) {
    return analyzeWorkflowTranscript({
      transcript: normalizedTranscripts[0].transcript,
      speaker: normalizedTranscripts[0].speaker,
      pendingItems,
      slotsFilled,
      model,
      includeIntent,
      includeSentiment,
    });
  }

  try {
    const { systemPrompt, userPrompt } = buildBatchAnalysisPrompt({
      transcripts: normalizedTranscripts,
      pendingItems,
      slotsFilled,
      includeIntent,
      includeSentiment,
    });

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
        model: model || "moonshotai/Kimi-K2.5",
        temperature: 0,
        max_tokens: 4000,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[WorkflowAnalyzer] Batch API error:", response.status, errorText);
      return getDefaultResult({ includeIntent, includeSentiment });
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    const analysis = parseWorkflowAnalysisMessage(message, "WorkflowAnalyzer Batch");

    if (!analysis) {
      console.error("[WorkflowAnalyzer] No parseable batch JSON in response", JSON.stringify(message));
      return getDefaultResult({ includeIntent, includeSentiment });
    }

    return normalizeAnalysisResult(analysis, pendingItems, {
      includeIntent,
      includeSentiment,
    });
  } catch (error) {
    console.error("[WorkflowAnalyzer] Batch error:", error);
    return getDefaultResult({ includeIntent, includeSentiment });
  }
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

function parseWorkflowAnalysisMessage(message, logPrefix) {
  const candidates = [message?.content, message?.reasoning]
    .filter((value) => typeof value === "string" && value.trim());
  let lastError = null;

  for (const rawContent of candidates) {
    const { parsed, error } = parseWorkflowAnalysisJson(rawContent);
    if (parsed) return parsed;
    lastError = error;
  }

  if (lastError) {
    console.error(`[${logPrefix}] JSON parse error:`, lastError.message);
  }
  return null;
}

function parseWorkflowAnalysisJson(rawContent) {
  const content = rawContent
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  try {
    return { parsed: JSON.parse(content), error: null };
  } catch (directParseError) {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { parsed: null, error: directParseError };
    }

    try {
      return { parsed: JSON.parse(jsonMatch[0]), error: null };
    } catch (extractedParseError) {
      return { parsed: null, error: extractedParseError };
    }
  }
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
  const validItemIds = new Set(pendingItems.map((i) => i.item_id));
  
  // Filter and validate completed items
  const completedItems = (analysis.completed_items || [])
    .filter((item) => {
      if (!item.item_id || !validItemIds.has(item.item_id)) {
        return false;
      }
      if (typeof item.confidence !== "number" || item.confidence < 0.60) {
        return false;
      }
      return true;
    })
    .map((item) => ({
      item_id: item.item_id,
      confidence: Math.min(1, Math.max(0, item.confidence)),
      extracted_value: item.extracted_value || null,
      source_text: item.source_text || null,
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

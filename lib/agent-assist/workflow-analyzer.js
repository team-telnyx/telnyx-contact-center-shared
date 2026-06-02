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
        temperature: 0.3,
        max_tokens: includeIntent || includeSentiment ? 800 : 500,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[WorkflowAnalyzer] API error:", response.status, errorText);
      return getDefaultResult({ includeIntent, includeSentiment });
    }

    const data = await response.json();
    // Kimi-K2.5 (and some reasoning models) put the answer in `reasoning` instead
    // of `content` when response_format: json_object is used. Fall back to reasoning.
    const rawContent =
      data.choices?.[0]?.message?.content ||
      data.choices?.[0]?.message?.reasoning ||
      null;

    if (!rawContent) {
      console.error("[WorkflowAnalyzer] No content in response", JSON.stringify(data?.choices?.[0]?.message));
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
          console.error("[WorkflowAnalyzer] JSON parse error:", parseError, "Content:", content.slice(0, 200));
          return getDefaultResult({ includeIntent, includeSentiment });
        }
      } else {
        console.error("[WorkflowAnalyzer] JSON parse error:", parseError, "Content:", content.slice(0, 200));
        return getDefaultResult({ includeIntent, includeSentiment });
      }
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
      item.confidence = confidence;
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

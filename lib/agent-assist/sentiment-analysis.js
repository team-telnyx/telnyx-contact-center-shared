import { sentimentSystem } from '../ai-operations/prompts/core.mjs';
import { prepareAiOperation } from '@/lib/ai-operations/runtime.mjs';
/**
 * Agent Assist - Sentiment and Intent Analysis
 *
 * Uses Telnyx AI chat completion for dynamic intent and sentiment analysis
 */

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const AUXILIARY_ANALYSIS_TIMEOUT_MS = 5000;

const defaultAnalysis = () => ({
  intent: "general inquiry",
  sentiment: "neutral",
  sentimentScore: 50,
  tags: [],
});

/**
 * Analyze transcript for sentiment and intent using Telnyx AI
 * @param {string} transcript - The transcribed text
 * @param {Object} [options] - Analysis options
 * @param {string} [options.model] - Workflow-configured LLM model
 * @param {boolean} [options.includeIntent] - Run intent/tag extraction
 * @param {boolean} [options.includeSentiment] - Run sentiment extraction
 * @returns {Promise<Object>} Requested auxiliary analysis fields
 */
export async function analyzeTranscription(transcript, {
  model,
  includeIntent = true,
  includeSentiment = true,
  signal,
} = {}) {
  if (!transcript || typeof transcript !== "string" || (!includeIntent && !includeSentiment)) {
    return defaultAnalysis();
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason || new Error("Auxiliary analysis cancelled"));
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`Auxiliary analysis timed out after ${AUXILIARY_ANALYSIS_TIMEOUT_MS}ms`)),
    AUXILIARY_ANALYSIS_TIMEOUT_MS,
  );
  try {
    const systemPrompt = sentimentSystem({ includeIntent, includeSentiment });

    const userPrompt = `Analyze this transcription segment:\n\n"${transcript}"`;

    const response = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify(await prepareAiOperation('sentiment-intent', {
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        temperature: 0.3,
        max_tokens: includeIntent && includeSentiment ? 180 : 100,
        response_format: { type: "json_object" },
        // Intent/sentiment classification is always a small, separate request;
        // it must never pay reasoning latency even if workflow slot reasoning
        // was explicitly enabled by an administrator.
        enable_thinking: false,
      }, {preferredModel: model})),
    });

    if (!response.ok) {
      throw new Error(`Auxiliary analysis HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning;

    if (!content) {
      throw new Error("Auxiliary analysis returned no response content");
    }

    // Parse the JSON response from the selected model
    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch (parseError) {
      throw new Error("Auxiliary analysis returned invalid JSON", { cause: parseError });
    }

    const result = defaultAnalysis();
    if (includeIntent && typeof analysis.intent === "string" && analysis.intent.trim()) {
      result.intent = analysis.intent.trim();
      result.tags = Array.isArray(analysis.tags)
        ? analysis.tags.filter((tag) => typeof tag === "string" && tag.trim()).slice(0, 3)
        : [];
    }

    if (includeSentiment) {
      const sentiment = String(analysis.sentiment || "neutral").toLowerCase();
      result.sentiment = ["positive", "neutral", "negative"].includes(sentiment)
        ? sentiment
        : "neutral";
      const score = Number(analysis.sentimentScore);
      result.sentimentScore = Number.isFinite(score)
        ? Math.max(0, Math.min(100, Math.round(score)))
        : 50;
    }
    return result;
  } catch {
    return defaultAnalysis();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export { getIntentLabel, getSentimentColor } from "./sentiment-display.js";

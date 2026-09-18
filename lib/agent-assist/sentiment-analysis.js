/**
 * Agent Assist - Sentiment and Intent Analysis
 *
 * Uses Telnyx AI chat completion for dynamic intent and sentiment analysis
 */

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const DEFAULT_AGENT_ASSIST_LLM_MODEL = "openai/gpt-4o";
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
    const requestedTasks = [];
    const responseFields = [];
    if (includeIntent) {
      requestedTasks.push("Return a concise 2-3 word intent and up to 3 short topic tags.");
      responseFields.push('"intent":"short intent"', '"tags":["tag1","tag2","tag3"]');
    }
    if (includeSentiment) {
      requestedTasks.push("Classify emotional tone as positive, neutral, or negative and score it from 0 to 100. Factual negative answers such as 'no allergies' are neutral unless emotion is expressed.");
      responseFields.push('"sentiment":"positive|neutral|negative"', '"sentimentScore":50');
    }
    const systemPrompt = `Analyze one contact-center transcription segment.\n${requestedTasks.join("\n")}\nRespond only with compact valid JSON: {${responseFields.join(",")}}`;

    const userPrompt = `Analyze this transcription segment:\n\n"${transcript}"`;

    const response = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
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
        model: model || DEFAULT_AGENT_ASSIST_LLM_MODEL,
        temperature: 0.3,
        max_tokens: includeIntent && includeSentiment ? 180 : 100,
        response_format: { type: "json_object" },
        // Intent/sentiment classification is always a small, separate request;
        // it must never pay reasoning latency even if workflow slot reasoning
        // was explicitly enabled by an administrator.
        enable_thinking: false,
      }),
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

/**
 * Get display label for intent
 * Since intents are now dynamically generated by the selected LLM, we just capitalize them properly
 * @param {string} intent - Intent description
 * @returns {string} Display label
 */
export function getIntentLabel(intent) {
  if (!intent) return "General Inquiry";

  // Capitalize first letter of each word for better display
  return intent
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Get color class for sentiment
 * @param {string} sentiment - Sentiment label
 * @returns {string} Tailwind color classes
 */
export function getSentimentColor(sentiment) {
  const colors = {
    positive: "bg-green-100 text-green-800 border-green-300",
    neutral: "bg-gray-100 text-gray-800 border-gray-300",
    negative: "bg-red-100 text-red-800 border-red-300",
  };

  return colors[sentiment] || colors.neutral;
}

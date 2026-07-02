/**
 * Agent Assist - Sentiment and Intent Analysis
 *
 * Uses Telnyx AI chat completion for dynamic intent and sentiment analysis
 */

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const DEFAULT_AGENT_ASSIST_LLM_MODEL = "openai/gpt-4o";

/**
 * Analyze transcript for sentiment and intent using Telnyx AI
 * @param {string} transcript - The transcribed text
 * @param {Object} [options] - Analysis options
 * @param {string} [options.model] - Workflow-configured LLM model
 * @returns {Promise<Object>} Analysis results with intent, sentiment, and score
 */
export async function analyzeTranscription(transcript, { model } = {}) {
  if (!transcript || typeof transcript !== "string") {
    return {
      intent: "general inquiry",
      sentiment: "neutral",
      sentimentScore: 50,
      tags: [],
    };
  }

  try {
    // Build the prompt for the workflow-configured model to analyze the transcription
    const systemPrompt = `You are an expert contact center AI assistant that analyzes customer service call transcriptions. Your task is to analyze each transcription segment and provide:

1. **Intent**: A SHORT 2-3 word phrase describing what the speaker wants. Examples: "billing inquiry", "password reset", "network printer issue", "purchase product", "cancel subscription", "technical support", etc.

2. **Sentiment**: Classify the emotional tone as one of: "positive", "neutral", or "negative"

3. **Sentiment Score**: A numerical score from 0-100 where:
   - 0-30: Very negative
   - 31-45: Somewhat negative
   - 46-55: Neutral
   - 56-70: Somewhat positive
   - 71-100: Very positive

4. **Tags**: Generate exactly 3 relevant tags (1-2 words each) that describe key topics, issues, or entities mentioned. Examples: "billing", "refund", "account", "technical", "urgent", "frustrated", "product name", etc.

Respond ONLY with valid JSON in this exact format:
{
  "intent": "short intent",
  "sentiment": "positive|neutral|negative",
  "sentimentScore": 50,
  "tags": ["tag1", "tag2", "tag3"]
}`;

    const userPrompt = `Analyze this transcription segment:\n\n"${transcript}"`;

    // Call Telnyx AI chat completion with the workflow-configured model
    const response = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
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
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Fallback to default values on error
      return {
        intent: "general inquiry",
        sentiment: "neutral",
        sentimentScore: 50,
        tags: [],
      };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning;

    if (!content) {
      return {
        intent: "general inquiry",
        sentiment: "neutral",
        sentimentScore: 50,
        tags: [],
      };
    }

    // Parse the JSON response from the selected model
    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch (parseError) {
      return {
        intent: "general inquiry",
        sentiment: "neutral",
        sentimentScore: 50,
        tags: [],
      };
    }

    // Validate the response structure
    if (
      !analysis.intent ||
      !analysis.sentiment ||
      typeof analysis.sentimentScore !== "number"
    ) {
      return {
        intent: "general inquiry",
        sentiment: "neutral",
        sentimentScore: 50,
        tags: [],
      };
    }

    // Normalize sentiment to lowercase
    analysis.sentiment = analysis.sentiment.toLowerCase();

    // Ensure sentiment is one of the valid values
    if (!["positive", "neutral", "negative"].includes(analysis.sentiment)) {
      analysis.sentiment = "neutral";
    }

    // Ensure sentiment score is in valid range
    analysis.sentimentScore = Math.max(
      0,
      Math.min(100, analysis.sentimentScore)
    );

    // Ensure tags is an array with exactly 3 items
    if (!Array.isArray(analysis.tags)) {
      analysis.tags = [];
    }
    // Limit to 3 tags and ensure they're strings
    analysis.tags = analysis.tags
      .filter((tag) => typeof tag === "string" && tag.trim().length > 0)
      .slice(0, 3);

    return {
      intent: analysis.intent,
      sentiment: analysis.sentiment,
      sentimentScore: analysis.sentimentScore,
      tags: analysis.tags,
    };
  } catch (error) {
    // Fallback to default values on error
    return {
      intent: "general inquiry",
      sentiment: "neutral",
      sentimentScore: 50,
      tags: [],
    };
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

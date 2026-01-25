/**
 * Generate a short call summary from transcription using Telnyx AI chat completion
 */

import { buildTelnyxV2Url } from "@/lib/telnyx";

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

/**
 * Generate a short call summary from transcription text
 * @param {string} transcriptionText - The transcription text
 * @returns {Promise<string|null>} - The generated summary or null if failed
 */
export async function generateCallSummary(transcriptionText) {
  if (!transcriptionText || !transcriptionText.trim()) {
    return null;
  }

  try {
    const systemPrompt = `You are an expert contact center AI assistant. Your task is to generate a concise, professional summary of customer service call transcriptions.

Generate a brief summary (2-4 sentences) that includes:
- The main topic or issue discussed
- Key points or outcomes
- Any action items or resolutions

Keep the summary clear, professional, and focused on the most important information.`;

    const userPrompt = `Generate a short summary of this call transcription:\n\n"${transcriptionText}"`;

    const apiKey = getApiKey();
    const url = buildTelnyxV2Url("/ai/chat/completions");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
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
        model: "openai/gpt-4o",
        temperature: 0.7,
        max_tokens: 300,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        "[CallSummary] Telnyx AI API error:",
        response.status,
        errorText
      );
      return null;
    }

    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content;

    if (!summary) {
      console.error("[CallSummary] No summary in response:", data);
      return null;
    }

    return summary.trim();
  } catch (error) {
    console.error("[CallSummary] Error generating summary:", error);
    return null;
  }
}


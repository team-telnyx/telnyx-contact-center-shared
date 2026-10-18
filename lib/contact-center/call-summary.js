import { callSummaryUser } from '../ai-operations/prompts/core.mjs';
import { callSummarySystem } from '../ai-operations/prompts/core.mjs';
import { prepareAiOperation } from '@/lib/ai-operations/runtime.mjs';
/**
 * Generate a short call summary from transcription using Telnyx AI chat completion
 */

import { buildTelnyxV2Url } from "@/lib/telnyx";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

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
    const systemPrompt = callSummarySystem();

    const userPrompt = callSummaryUser(transcriptionText);

    const apiKey = getApiKey();
    const url = buildTelnyxV2Url("/ai/chat/completions");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(await prepareAiOperation('call-summary', {
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
        temperature: 0.7,
        max_tokens: 300,
      })),
    });

    if (!response.ok) {
      const errorText = await response.text();
      contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return null;
    }

    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content;

    if (!summary) {
      contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return null;
    }

    return summary.trim();
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return null;
  }
}


import { liveTranslationSystem } from '../ai-operations/prompts/core.mjs';
import { prepareAiOperation, operationModel } from '@/lib/ai-operations/runtime.mjs';
import { agentAssistRuntimePayload, translationLogger } from "./logging.mjs";
const TELNYX_API_BASE = "https://api.telnyx.com/v2";

function normalizeLanguage(language) {
  if (!language || typeof language !== "string") return null;
  const trimmed = language.trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") return null;
  return trimmed;
}

function extractMessageContent(data) {
  return (
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.message?.reasoning ||
    ""
  ).trim();
}

function stripCodeFences(text) {
  return String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

async function telnyxChatCompletion({ messages, model, maxTokens = 300, responseFormat, operation = true }) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    translationLogger.warn("translationservice", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    return null;
  }

  const response = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(await (async () => {
      const request = {
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: responseFormat || { type: "json_object" },
        enable_thinking: false,
      };
      // Language detection skips administrator guidance but still uses the
      // configured model chain (workflow > AI Copilot > platform default).
      return operation
        ? prepareAiOperation("live-translation", request, { preferredModel: model })
        : { ...request, model: await operationModel("live-translation", model) };
    })()),
  });

  if (!response.ok) {
    const providerErrorSummary = await response.text().catch(() => "");
    translationLogger.warn("translationservice", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    return null;
  }

  return response.json();
}

export async function detectLanguage(text, { model } = {}) {
  if (!text || typeof text !== "string" || !text.trim()) return null;

  try {
    const data = await telnyxChatCompletion({
      model,
      operation: false,
      maxTokens: 120,
      responseFormat: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You identify the primary language of contact-center transcripts.",
            "Return only JSON: {\"language\":\"BCP-47 code or null\",\"confidence\":0.0}.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({ transcript: text.trim() }),
        },
      ],
    });

    const raw = stripCodeFences(extractMessageContent(data));
    if (!raw) return null;
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    const language = normalizeLanguage(
      parsed?.language || parsed?.detected_language || parsed?.detectedLanguage
    );
    if (!language) return null;

    return {
      language,
      confidence: typeof parsed?.confidence === "number" ? parsed.confidence : null,
    };
  } catch (err) {
    translationLogger.warn("translationservice", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    return null;
  }
}

export async function translateText({ text, sourceLanguage, targetLanguage, model }) {
  const source = normalizeLanguage(sourceLanguage);
  const target = normalizeLanguage(targetLanguage);
  if (!text || typeof text !== "string" || !text.trim() || !target) return null;

  try {
    const data = await telnyxChatCompletion({
      model,
      maxTokens: Math.min(1200, Math.max(120, Math.ceil(text.length * 1.5))),
      responseFormat: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: liveTranslationSystem(),
        },
        {
          role: "user",
          content: JSON.stringify({
            source_language: source || "auto",
            target_language: target,
            transcript: text.trim(),
          }),
        },
      ],
    });

    const raw = stripCodeFences(extractMessageContent(data));
    if (!raw) return null;
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    const translatedText = parsed?.translated_text || parsed?.translation || parsed?.text;
    if (!translatedText || typeof translatedText !== "string") return null;

    return {
      text: translatedText,
      detectedSourceLanguage: parsed.detected_source_language || parsed.detectedSourceLanguage || source || null,
    };
  } catch (err) {
    translationLogger.warn("translationservice", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    return null;
  }
}

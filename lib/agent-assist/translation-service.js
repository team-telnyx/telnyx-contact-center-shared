const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const DEFAULT_TRANSLATION_MODEL = process.env.TELNYX_AI_TRANSLATION_MODEL || "openai/gpt-4o";

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

async function telnyxChatCompletion({ messages, model, maxTokens = 300, responseFormat }) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    console.warn("[TranslationService] TELNYX_API_KEY is missing");
    return null;
  }

  const response = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || DEFAULT_TRANSLATION_MODEL,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: responseFormat || { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.warn("[TranslationService] Telnyx AI request failed:", response.status, errorText);
    return null;
  }

  return response.json();
}

export async function detectLanguage(text, { model } = {}) {
  if (!text || typeof text !== "string" || !text.trim()) return null;

  try {
    const data = await telnyxChatCompletion({
      model,
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
    console.warn("[TranslationService] Detect language error:", err);
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
          content: [
            "You are a professional live contact-center translator.",
            "Translate the transcript faithfully into the target language.",
            "Preserve meaning, names, numbers, product terms, punctuation, and tone.",
            "Do not add explanations or commentary.",
            'Return only JSON: {"translated_text":"...","detected_source_language":"BCP-47 code or null"}.',
          ].join(" "),
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
    console.warn("[TranslationService] Translate error:", err);
    return null;
  }
}

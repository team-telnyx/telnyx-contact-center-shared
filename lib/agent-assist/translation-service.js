const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;

function normalizeLanguage(language) {
  if (!language || typeof language !== "string") return null;
  return language.trim();
}

export async function detectLanguage(text) {
  if (!GOOGLE_TRANSLATE_API_KEY || !text) return null;

  const url = `https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TRANSLATE_API_KEY}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text }),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const errorMsg = data?.error?.message || "detect failed";
      console.warn("[TranslationService] Detect language failed:", errorMsg);
      return null;
    }

    const data = await resp.json();
    const detection = data?.data?.detections?.[0]?.[0];
    if (!detection?.language) return null;

    return {
      language: detection.language,
      confidence: typeof detection.confidence === "number" ? detection.confidence : null,
    };
  } catch (err) {
    console.warn("[TranslationService] Detect language error:", err);
    return null;
  }
}

export async function translateText({ text, sourceLanguage, targetLanguage }) {
  if (!GOOGLE_TRANSLATE_API_KEY || !text || !targetLanguage) return null;

  const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_API_KEY}`;
  const source = normalizeLanguage(sourceLanguage);
  const target = normalizeLanguage(targetLanguage);

  if (!target) return null;

  const body = {
    q: text,
    target,
    format: "text",
  };

  if (source && source !== "auto") {
    body.source = source;
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const errorMsg = data?.error?.message || "translate failed";
      console.warn("[TranslationService] Translate failed:", errorMsg);
      return null;
    }

    const data = await resp.json();
    const translation = data?.data?.translations?.[0];
    if (!translation?.translatedText) return null;

    return {
      text: translation.translatedText,
      detectedSourceLanguage: translation.detectedSourceLanguage || null,
    };
  } catch (err) {
    console.warn("[TranslationService] Translate error:", err);
    return null;
  }
}

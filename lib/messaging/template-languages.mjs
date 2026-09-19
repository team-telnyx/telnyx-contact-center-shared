// One language catalogue for every messaging template builder. WhatsApp needs
// Meta's template language tags, and SMS stores the same tag so a workspace
// reads one list with one set of flags everywhere.
export const TEMPLATE_LANGUAGES = Object.freeze([
  ["af", "Afrikaans", "🇿🇦"], ["sq", "Albanian", "🇦🇱"], ["ar", "Arabic", "🇸🇦"], ["az", "Azerbaijani", "🇦🇿"], ["bn", "Bengali", "🇧🇩"], ["bg", "Bulgarian", "🇧🇬"], ["ca", "Catalan", "🇪🇸"],
  ["zh_CN", "Chinese (China)", "🇨🇳"], ["zh_HK", "Chinese (Hong Kong)", "🇭🇰"], ["zh_TW", "Chinese (Taiwan)", "🇹🇼"], ["hr", "Croatian", "🇭🇷"], ["cs", "Czech", "🇨🇿"], ["da", "Danish", "🇩🇰"],
  ["nl", "Dutch", "🇳🇱"], ["en", "English", "🇬🇧"], ["en_GB", "English (United Kingdom)", "🇬🇧"], ["en_US", "English (United States)", "🇺🇸"], ["et", "Estonian", "🇪🇪"], ["fil", "Filipino", "🇵🇭"],
  ["fi", "Finnish", "🇫🇮"], ["fr", "French", "🇫🇷"], ["ka", "Georgian", "🇬🇪"], ["de", "German", "🇩🇪"], ["el", "Greek", "🇬🇷"], ["gu", "Gujarati", "🇮🇳"], ["ha", "Hausa", "🇳🇬"], ["he", "Hebrew", "🇮🇱"],
  ["hi", "Hindi", "🇮🇳"], ["hu", "Hungarian", "🇭🇺"], ["id", "Indonesian", "🇮🇩"], ["ga", "Irish", "🇮🇪"], ["it", "Italian", "🇮🇹"], ["ja", "Japanese", "🇯🇵"], ["kn", "Kannada", "🇮🇳"], ["kk", "Kazakh", "🇰🇿"],
  ["rw_RW", "Kinyarwanda", "🇷🇼"], ["ko", "Korean", "🇰🇷"], ["ky_KG", "Kyrgyz", "🇰🇬"], ["lo", "Lao", "🇱🇦"], ["lv", "Latvian", "🇱🇻"], ["lt", "Lithuanian", "🇱🇹"], ["mk", "Macedonian", "🇲🇰"],
  ["ms", "Malay", "🇲🇾"], ["ml", "Malayalam", "🇮🇳"], ["mr", "Marathi", "🇮🇳"], ["nb", "Norwegian", "🇳🇴"], ["fa", "Persian", "🇮🇷"], ["pl", "Polish", "🇵🇱"], ["pt_BR", "Portuguese (Brazil)", "🇧🇷"],
  ["pt_PT", "Portuguese (Portugal)", "🇵🇹"], ["pa", "Punjabi", "🇮🇳"], ["ro", "Romanian", "🇷🇴"], ["ru", "Russian", "🇷🇺"], ["sr", "Serbian", "🇷🇸"], ["sk", "Slovak", "🇸🇰"], ["sl", "Slovenian", "🇸🇮"],
  ["es", "Spanish", "🇪🇸"], ["es_AR", "Spanish (Argentina)", "🇦🇷"], ["es_ES", "Spanish (Spain)", "🇪🇸"], ["es_MX", "Spanish (Mexico)", "🇲🇽"], ["sw", "Swahili", "🇰🇪"], ["sv", "Swedish", "🇸🇪"],
  ["ta", "Tamil", "🇮🇳"], ["te", "Telugu", "🇮🇳"], ["th", "Thai", "🇹🇭"], ["tr", "Turkish", "🇹🇷"], ["uk", "Ukrainian", "🇺🇦"], ["ur", "Urdu", "🇵🇰"], ["uz", "Uzbek", "🇺🇿"], ["vi", "Vietnamese", "🇻🇳"], ["zu", "Zulu", "🇿🇦"],
].map(([code, name, flag]) => Object.freeze({ code, name, flag })));

const BY_CODE = new Map(TEMPLATE_LANGUAGES.map((language) => [language.code.toLowerCase(), language]));
const key = (code) => String(code || "").trim().replace(/-/g, "_").toLowerCase();

/** Catalogue entry for a code, matched case-insensitively (`pt-BR` → `pt_BR`). */
export function templateLanguage(code) {
  return BY_CODE.get(key(code)) || null;
}

/**
 * Canonical catalogue code when the language is known. Unknown codes stay as a
 * sanitized free-form tag so rows written before the picker keep their value.
 */
export function normalizeTemplateLanguage(code, fallback = "en") {
  const known = templateLanguage(code);
  if (known) return known.code;
  const free = key(code).replace(/[^a-z0-9_]/g, "").slice(0, 12);
  return free || fallback;
}

// UI preferences are deliberately independent of users.language (speech/STT).
export const DEFAULT_UI_LOCALE = "en-US";
export const UI_LOCALE_COOKIE = "cc_ui_locale";
export const UI_LOCALES = Object.freeze([{
  id: "en-US",
  name: "English",
  direction: "ltr"
}, {
  id: "de-DE",
  name: "Deutsch",
  direction: "ltr"
}, {
  id: "nl-NL",
  name: "Nederlands",
  direction: "ltr"
}, {
  id: "es-ES",
  name: "Español",
  direction: "ltr"
}, {
  id: "fr-FR",
  name: "Français",
  direction: "ltr"
}, {
  id: "pt-PT",
  name: "Português",
  direction: "ltr"
}, {
  id: "it-IT",
  name: "Italiano",
  direction: "ltr"
}, {
  id: "pl-PL",
  name: "Polski",
  direction: "ltr"
}]);
export function isUiLocale(value) {
  return typeof value === "string" && UI_LOCALES.some(({
    id
  }) => id === value);
}
export function normalizeUiLocale(value) {
  return isUiLocale(value) ? value : DEFAULT_UI_LOCALE;
}

// Keep direction resolution independent of the released language list so RTL
// components can be exercised before an Arabic catalogue is released.
export function localeDirection(locale) {
  return /^(ar|he|fa|ur)(-|$)/i.test(String(locale || "")) ? "rtl" : "ltr";
}

// Stable, portable source-message IDs. The catalogue check rejects collisions.
export function messageId(source, context = "") {
  // Preserve existing IDs; distinguish ambiguous words by their UI meaning.
  const input = context ? `${context}\u0000${source}` : source;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(i), 0x01000193);
  }
  return `m${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
export function uiLocaleCookieOptions() {
  return {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production"
  };
}

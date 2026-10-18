import { normalizeUiLocale } from "./locales.mjs";
const loaders = {
  "en-US": () => import("@/messages/en-US.json"),
  "de-DE": () => import("@/messages/de-DE.json"),
  "nl-NL": () => import("@/messages/nl-NL.json"),
  "es-ES": () => import("@/messages/es-ES.json"),
  "fr-FR": () => import("@/messages/fr-FR.json"),
  "pt-PT": () => import("@/messages/pt-PT.json"),
  "it-IT": () => import("@/messages/it-IT.json"),
  "pl-PL": () => import("@/messages/pl-PL.json")
};
const cache = new Map();
export function loadUiMessages(locale) {
  const selected = normalizeUiLocale(locale);
  if (!cache.has(selected)) {
    const pending = Promise.all([loaders["en-US"](), loaders[selected]()]).then(([english, translated]) => ({
      ui: {
        ...english.default.ui,
        ...translated.default.ui
      }
    }));
    cache.set(selected, pending);
    pending.catch(() => cache.delete(selected));
  }
  return cache.get(selected);
}

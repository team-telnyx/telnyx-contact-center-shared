"use client";

import { createContext, useMemo, useContext } from "react";
import { useLocale, useMessages, useTranslations } from "next-intl";
import { messageId } from "@/lib/i18n/locales.mjs";
const englishFallback = (source, values) => typeof source === "string" && values ? source.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match) : source;
englishFallback.locale = "en-US";
const UiTextContext = createContext(englishFallback);
export function UiTextProvider({
  children
}) {
  const locale = useLocale();
  const translate = useTranslations("ui");
  const messages = useMessages();
  const text = useMemo(() => Object.assign((source, values, context) => {
    if (typeof source !== "string") return source;
    const id = messageId(source, context);
    // Match JSX's empty rendering for absent values and keep booleans usable
    // in plain ICU arguments. Customer text is interpolated, never translated.
    const parameters = values && Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value == null ? "" : typeof value === "boolean" ? String(value) : value]));
    if (Object.hasOwn(messages.ui || {}, id)) return translate(id, parameters);
    // English is a defensive fallback; catalogue checks reject missing keys.
    return englishFallback(source, parameters);
  }, {
    locale
  }), [translate, messages, locale]);
  return <UiTextContext.Provider value={text}>{children}</UiTextContext.Provider>;
}

/** Translate application-owned copy only. Never pass customer/configuration data. */
export function useUiText() {
  return useContext(UiTextContext);
}
export function UiText({
  children,
  values,
  context
}) {
  const t = useUiText();
  return t(children, values, context);
}

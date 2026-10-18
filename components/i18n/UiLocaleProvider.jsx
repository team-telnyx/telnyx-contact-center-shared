"use client";

import { createContext, use, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NextIntlClientProvider } from "next-intl";
import { DirectionProvider } from "@radix-ui/react-direction";
import { DEFAULT_UI_LOCALE, localeDirection, normalizeUiLocale } from "@/lib/i18n/locales.mjs";
import { loadUiMessages } from "@/lib/i18n/messages";
import { UiTextProvider } from "./use-ui-text";
const LocaleContext = createContext(null);
export function UiLocaleProvider({
  locale: initialLocale = DEFAULT_UI_LOCALE,
  messages,
  children
}) {
  // Resolve the cacheable locale chunk in this client module on both SSR and
  // hydration. Passing the dictionary from the server layout would duplicate
  // the entire catalogue in every document's RSC payload.
  const initialMessages = messages ?? use(loadUiMessages(initialLocale));
  const [state, setState] = useState({
    locale: initialLocale,
    messages: initialMessages
  });
  const [pending, setPending] = useState(false);
  const revision = useRef(0);
  const currentLocale = useRef(initialLocale);
  const changeLocale = useCallback(async value => {
    const locale = normalizeUiLocale(value);
    const current = ++revision.current;
    // Auth/profile refreshes often repeat the server-rendered locale. Reuse
    // those messages instead of downloading the same bundle after hydration.
    if (locale === currentLocale.current) {
      setPending(false);
      return;
    }
    setPending(true);
    try {
      const messages = await loadUiMessages(locale);
      if (current === revision.current) {
        currentLocale.current = locale;
        setState({
          locale,
          messages
        });
      }
    } finally {
      if (current === revision.current) setPending(false);
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = state.locale;
    document.documentElement.dir = localeDirection(state.locale);
  }, [state.locale]);

  // The tree remains mounted when locale/messages change. Never key this
  // provider by locale: TelephonyProvider and drafts must survive a switch.
  const value = useMemo(() => ({
    locale: state.locale,
    direction: localeDirection(state.locale),
    pending,
    changeLocale
  }), [state.locale, pending, changeLocale]);
  return <LocaleContext.Provider value={value}>
      <NextIntlClientProvider locale={state.locale} messages={state.messages} timeZone="UTC">
        <DirectionProvider dir={value.direction}><UiTextProvider>{children}</UiTextProvider></DirectionProvider>
      </NextIntlClientProvider>
    </LocaleContext.Provider>;
}
export function useUiLocale() {
  return useContext(LocaleContext);
}

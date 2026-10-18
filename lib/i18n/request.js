import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { DEFAULT_UI_LOCALE, UI_LOCALE_COOKIE, normalizeUiLocale } from "./locales.mjs";
export const getUiRequestConfig = cache(async () => {
  const cookieStore = await cookies();
  const hasSession = cookieStore.getAll().some(({
    name
  }) => /^(?:__Secure-)?next-auth\.session-token(?:\.\d+)?$/.test(name));
  // A signed-in account always wins over a cookie from a previous account.
  const user = hasSession ? await getAuthenticatedUser() : null;
  const locale = user ? normalizeUiLocale(user.ui_locale) : hasSession ? DEFAULT_UI_LOCALE : normalizeUiLocale(cookieStore.get(UI_LOCALE_COOKIE)?.value);
  return {
    locale
  };
});

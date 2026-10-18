import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ThemeProvider } from "@/components/theme-provider";
import { ConditionalSessionProvider } from "@/components/conditional-session-provider";
import { Toaster } from "@/components/ToastNotify";
import { UiLocaleProvider } from "@/components/i18n/UiLocaleProvider";
import { getUiRequestConfig } from "@/lib/i18n/request";
import { localeDirection } from "@/lib/i18n/locales.mjs";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "Telnyx Contact Center",
  description: "Telnyx Contact Center",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
  },
};

export default async function RootLayout({ children }) {
  const { locale } = await getUiRequestConfig();
  return (
    <html lang={locale} dir={localeDirection(locale)} suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} flex flex-col`}
      >
        <Suspense fallback={
          <div className="flex min-h-screen gap-4 p-4" aria-busy="true" data-testid="ui-locale-loading">
            <Skeleton className="hidden w-60 md:block" />
            <div className="flex flex-1 flex-col gap-4">
              <Skeleton className="h-14" />
              <Skeleton className="flex-1" />
            </div>
          </div>
        }>
          <UiLocaleProvider locale={locale}>
            <ConditionalSessionProvider>
              <ThemeProvider
                attribute="class"
                defaultTheme="system"
                enableSystem
                disableTransitionOnChange
              >
                {children}
                <Toaster richColors position="bottom-right" />
              </ThemeProvider>
            </ConditionalSessionProvider>
          </UiLocaleProvider>
        </Suspense>
      </body>
    </html>
  );
}

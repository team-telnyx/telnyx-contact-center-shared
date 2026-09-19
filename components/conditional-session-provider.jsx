"use client";

import { usePathname } from "next/navigation";
import { SessionProviderWrapper } from "@/components/session-provider-wrapper";
import { AuthProvider } from "@/components/auth-provider";
import { needsPortalProviders } from "@/lib/portal-providers";

export function ConditionalSessionProvider({ children }) {
  const pathname = usePathname();
  if (!needsPortalProviders(pathname)) return children;
  return (
    <SessionProviderWrapper>
      <AuthProvider>{children}</AuthProvider>
    </SessionProviderWrapper>
  );
}

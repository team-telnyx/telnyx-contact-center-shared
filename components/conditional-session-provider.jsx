"use client";

import { usePathname } from "next/navigation";
import { SessionProviderWrapper } from "@/components/session-provider-wrapper";
import { AuthProvider } from "@/components/auth-provider";

export function ConditionalSessionProvider({ children }) {
  return (
    <SessionProviderWrapper>
      <AuthProvider>{children}</AuthProvider>
    </SessionProviderWrapper>
  );
}

"use client";

import { SessionProvider } from "next-auth/react";

export function SessionProviderWrapper({ children }) {
  return (
    <SessionProvider
      refetchInterval={5 * 60} // Refetch session every 5 minutes
      refetchOnWindowFocus={false} // Disable aggressive refetching
    >
      {children}
    </SessionProvider>
  );
}

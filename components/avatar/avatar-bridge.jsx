"use client";

import { createContext, useContext } from "react";

// The avatar stages need the Telnyx client, the playback arbitration of
// hooks/use-avatar-playback.js and a way to obtain a provider session token.
// The assistant test phone supplies these from the React provider; the widget
// voice runtime supplies them from its own client instance.
const AvatarBridgeContext = createContext(null);

export function AvatarBridgeProvider({ value, children }) {
  return (
    <AvatarBridgeContext.Provider value={value}>{children}</AvatarBridgeContext.Provider>
  );
}

export function useAvatarBridge() {
  const context = useContext(AvatarBridgeContext);
  if (!context) {
    throw new Error("useAvatarBridge must be used within AvatarBridgeProvider");
  }
  return context;
}

// Turns a session endpoint response into the token the SDKs expect, mapping
// server failures to the same reasons the stages report to onUnavailable.
export async function readAvatarSessionResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.sessionToken) {
    throw Object.assign(new Error(data?.error || "Avatar unavailable"), {
      reason: data?.reason || "provider_error",
    });
  }
  return data;
}

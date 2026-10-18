"use client";

import { voiceFetch } from "../telephony/endpoint-client.js";

export async function submitCoreHoldIntent(interactionId, action, requestId = crypto.randomUUID()) {
  if (!interactionId || !["hold", "unhold"].includes(action)) return null;
  const response = await voiceFetch(
    `/api/contact-center/interactions/${encodeURIComponent(interactionId)}/intents`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, requestId }),
      keepalive: true,
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || "Failed to record hold state");
  }
  return body.intent || null;
}

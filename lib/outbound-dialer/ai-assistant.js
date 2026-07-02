import { buildTelnyxV2Url } from "../telnyx.js";

export function buildAgentlessAiAssistantStartBody({
  assistantId,
  callControlId,
  eventType = "call.answered",
  ledgerId = null,
  campaignId = null,
}) {
  if (!assistantId) {
    throw new Error("assistantId is required to start an Agentless AI assistant");
  }

  const state = {
    source: "outbound_agentless_ai",
    call_control_id: callControlId || null,
    campaign_id: campaignId || null,
    ledger_id: ledgerId || null,
    trigger_event: eventType || null,
  };

  return {
    assistant: {
      id: assistantId,
    },
    client_state: Buffer.from(JSON.stringify(state)).toString("base64"),
    command_id: ledgerId
      ? `outbound-ai-assistant-start-${ledgerId}`
      : `outbound-ai-assistant-start-${callControlId || assistantId}`,
  };
}

export async function startAgentlessAiAssistantForCall({
  apiKey = process.env.TELNYX_API_KEY,
  callControlId,
  assistantId,
  eventType = "call.answered",
  ledgerId = null,
  campaignId = null,
  fetchImpl = global.fetch,
}) {
  if (!apiKey) {
    return { ok: false, reason: "missing_telnyx_api_key" };
  }
  if (!callControlId) {
    return { ok: false, reason: "missing_call_control_id" };
  }
  if (!assistantId) {
    return { ok: false, reason: "missing_assistant_id" };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, reason: "missing_fetch" };
  }

  const body = buildAgentlessAiAssistantStartBody({
    assistantId,
    callControlId,
    eventType,
    ledgerId,
    campaignId,
  });

  const response = await fetchImpl(
    buildTelnyxV2Url(`/calls/${encodeURIComponent(callControlId)}/actions/ai_assistant_start`),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const errorText = typeof response.text === "function" ? await response.text() : "";
    return {
      ok: false,
      reason: "telnyx_ai_assistant_start_failed",
      status: response.status,
      error: String(errorText || "").slice(0, 1200),
      request: body,
    };
  }

  const data = typeof response.json === "function" ? await response.json() : null;
  return { ok: true, data, request: body };
}

import { prewarmTelnyxSttAgentLeg } from "../telnyx-stt-handler.mjs";

export function agentAssistSttConfigFromClientState(clientState) {
  if (!clientState || typeof clientState !== "string") return null;
  try {
    const decoded = JSON.parse(Buffer.from(clientState, "base64").toString("utf8"));
    const config = decoded?.telnyx_stt_config;
    return config?.enabled ? config : null;
  } catch {
    return null;
  }
}

/** Start the agent provider socket while the transport leg is still ringing. */
export async function prewarmAgentAssistTransport({
  callControlId,
  clientState,
  interactionId,
  agentUsername,
  prewarm = prewarmTelnyxSttAgentLeg,
} = {}) {
  const config = agentAssistSttConfigFromClientState(clientState);
  if (!callControlId || !interactionId || !agentUsername || !config) return false;

  await prewarm(callControlId, config, interactionId, agentUsername);
  return true;
}

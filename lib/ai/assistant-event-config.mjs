import { createHmac, timingSafeEqual } from "node:crypto";
import { widgetAiRequest } from "../widgets/ai-provider.js";
import { ASSISTANT_EVENT_DESTINATION_CONFLICT } from "./assistant-event-conflicts.mjs";

export const ASSISTANT_EVENT_PATH = "/assistant-events";
export function assistantEventConfig(env = process.env) {
  const base = env.WS_BASE_URL || env.STREAMING_WS_URL;
  const key = env.ASSISTANT_EVENT_SECRET || env.NEXTAUTH_SECRET;
  if (!base || !key || key.length < 32) throw new Error("Configure a public WSS address and an assistant event secret (or NEXTAUTH_SECRET) before inviting AI with transcription.");
  const url = new URL(ASSISTANT_EVENT_PATH, base);
  if (url.protocol !== "wss:" || url.username || url.password) throw new Error("Assistant conversation events require a public wss:// address.");
  const token = createHmac("sha256", key).update(`cc-assistant-events:${url.href}`).digest("hex");
  return { url: url.href, token, identifier: `cc_events_${createHmac("sha256", token).update("identifier").digest("hex").slice(0, 24)}` };
}

export function authorizeAssistantEvents(header, config) {
  const incoming = Buffer.from(typeof header === "string" ? header : "");
  const expected = Buffer.from(`Bearer ${config.token}`);
  return incoming.length === expected.length && timingSafeEqual(incoming, expected);
}

function displayDestination(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    const hasPrivateParts = Boolean(url.search || url.hash);
    url.search = "";
    url.hash = "";
    const safePath = url.pathname === ASSISTANT_EVENT_PATH ? ASSISTANT_EVENT_PATH : "/… (path hidden)";
    return `${url.origin}${safePath}${hasPrivateParts ? " (query/fragment hidden)" : ""}`;
  } catch { return "Unrecognized destination"; }
}

export function assistantEventDestinationConflict(assistant, config) {
  const current = assistant.websocket_settings;
  if (!current?.enabled || current.url === config.url) return null;
  // Bind consent to this assistant, its observed settings, and this receiver.
  // Never return credentials or private URL query parameters to the browser.
  const confirmationToken = createHmac("sha256", config.token).update(JSON.stringify({
    id: assistant.id, enabled: current.enabled, url: current.url, auth: current.auth_ref,
    target: config.url, targetAuth: config.identifier,
  })).digest("hex");
  return {
    assistantId: assistant.id, assistantName: assistant.name || assistant.id,
    currentUrl: displayDestination(current.url), targetUrl: displayDestination(config.url), confirmationToken,
  };
}

export function assertAssistantEventDestinations(assistants, config, confirmations = []) {
  const accepted = Array.isArray(confirmations) ? confirmations : [];
  const conflicts = assistants.map(assistant => assistantEventDestinationConflict(assistant, config))
    .filter(conflict => conflict && !accepted.some(item => item?.assistantId === conflict.assistantId && item.confirmationToken === conflict.confirmationToken));
  if (conflicts.length) throw Object.assign(new Error(`${conflicts.map(item => item.assistantName).join(", ")} already uses a different Conversation WebSocket. Confirm replacing the destination to save this call flow.`), {
    status: 409, code: ASSISTANT_EVENT_DESTINATION_CONFLICT, conflicts,
  });
}

export function assertAssistantEventDestination(assistant, config, confirmations = []) {
  assertAssistantEventDestinations([assistant], config, confirmations);
}

function matchesReceiver(assistant, config) {
  const current = assistant.websocket_settings;
  return current?.enabled && current.url === config.url && current.auth_ref === config.identifier;
}

export function assertAssistantEventWriteAccess(assistants, config, canUpdateAssistant) {
  if (canUpdateAssistant !== true && assistants.some(assistant => !matchesReceiver(assistant, config))) {
    throw Object.assign(new Error("Configuring or replacing an assistant's Conversation WebSocket requires the ai_assistants:update permission. Ask an AI assistant administrator to prepare the selected assistants."), { status: 403 });
  }
}

// Only observer settings are patched. Replacing an existing observer requires
// explicit consent because it may also answer delegated tools.
export async function configureAssistantEvents(assistant, { request = widgetAiRequest, config = assistantEventConfig(), confirmations = [], canUpdateAssistant = false, changes } = {}) {
  const settings = { enabled: true, url: config.url, auth_ref: config.identifier };
  assertAssistantEventWriteAccess([assistant], config, canUpdateAssistant);
  assertAssistantEventDestination(assistant, config, confirmations);
  if (matchesReceiver(assistant, config)) return settings;
  let found = false;
  for (let page = 1; page <= 100; page++) {
    const response = await request(`/integration_secrets?page[number]=${page}&page[size]=100`);
    found = (response.data || []).some(secret => secret.identifier === config.identifier && secret.type === "bearer");
    if (found || page >= Number(response.meta?.total_pages || 1)) break;
  }
  if (!found) {
    try { await request("/integration_secrets", { method: "POST", body: { type: "bearer", identifier: config.identifier, token: config.token } }); }
    catch (error) {
      // A concurrent invitation may have created the same deterministic secret.
      const response = await request("/integration_secrets?page[size]=250");
      if (!(response.data || []).some(secret => secret.identifier === config.identifier && secret.type === "bearer")) throw error;
    }
  }
  // Secret lookup may take time. Re-read immediately before the write so consent
  // for an old destination cannot replace a change observed during preparation.
  const latestResponse = await request(`/ai/assistants/${encodeURIComponent(assistant.id)}`);
  const latest = latestResponse.data || latestResponse;
  if (latest.id !== assistant.id) throw new Error("The selected assistant could not be verified before configuring its Conversation WebSocket.");
  assertAssistantEventWriteAccess([latest], config, canUpdateAssistant);
  assertAssistantEventDestination(latest, config, confirmations);
  if (matchesReceiver(latest, config)) return settings;
  // Record before POST as a failed/timeout response can still have applied it.
  changes?.push({ id: assistant.id, name: assistant.name || assistant.id, before: structuredClone(latest.websocket_settings || { enabled: false }), after: settings });
  await request(`/ai/assistants/${encodeURIComponent(assistant.id)}`, { method: "POST", body: { websocket_settings: settings } });
  const result = await request(`/ai/assistants/${encodeURIComponent(assistant.id)}`);
  const saved = (result.data || result).websocket_settings;
  if (!saved?.enabled || saved.url !== settings.url || saved.auth_ref !== settings.auth_ref) throw new Error("The assistant's Conversation WebSocket configuration could not be verified.");
  return settings;
}

const sameSettings = (left, right) => Boolean(left?.enabled) === Boolean(right?.enabled)
  && (left?.url || null) === (right?.url || null) && (left?.auth_ref || null) === (right?.auth_ref || null);

export async function restoreAssistantEventChanges(changes, request = widgetAiRequest) {
  const failed = [];
  for (const change of [...changes].reverse()) {
    try {
      const path = `/ai/assistants/${encodeURIComponent(change.id)}`;
      const result = await request(path);
      const current = (result.data || result).websocket_settings;
      if (sameSettings(current, change.before)) continue;
      // Do not undo an unrelated administrator's newer configuration.
      if (!sameSettings(current, change.after)) throw new Error("Changed concurrently");
      await request(path, { method: "POST", body: { websocket_settings: change.before } });
      const verified = await request(path);
      if (!sameSettings((verified.data || verified).websocket_settings, change.before)) throw new Error("Restoration could not be verified");
    } catch { failed.push(change.name); }
  }
  return failed;
}

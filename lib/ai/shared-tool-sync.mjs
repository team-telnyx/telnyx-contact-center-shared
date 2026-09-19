// Keeps the shared (Tools Library) attachments of a Telnyx assistant in step
// with the tools list the editor saves. Network access is injectable for tests.
import { buildTelnyxV2Url } from "../telnyx.js";
import { telnyxErrorDetail } from "../telnyx-error.mjs";
import {
  extractSharedToolIds,
  findDuplicateWebhookToolNames,
  getAssistantToolId,
  getWebhookToolName,
  isLibraryAssistantTool,
  stripSharedToolsForAssistantUpdate,
} from "./tool-library.js";

function headers(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function telnyxRequest(fetchImpl, apiKey, path, init = {}) {
  const res = await fetchImpl(buildTelnyxV2Url(path), { ...init, headers: headers(apiKey), cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error(telnyxErrorDetail(text, `Telnyx API error: ${res.status}`)), { status: res.status, body: text });
  }
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    return data?.data ?? data;
  } catch {
    return null;
  }
}

export async function fetchLibraryToolIds(apiKey, { fetchImpl = fetch } = {}) {
  const ids = new Set();
  for (let page = 1; page <= 20; page += 1) {
    const data = await telnyxRequest(fetchImpl, apiKey, `/ai/tools?page[number]=${page}&page[size]=100`);
    const items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    for (const tool of items) {
      const id = getAssistantToolId(tool);
      if (id) ids.add(String(id));
    }
    if (items.length < 100) break;
  }
  return ids;
}

export async function fetchAssistant(apiKey, assistantId, { fetchImpl = fetch } = {}) {
  return telnyxRequest(fetchImpl, apiKey, `/ai/assistants/${encodeURIComponent(assistantId)}`);
}

// Splits the payload for a save. Returns the payload Telnyx receives (inline
// tools only), the shared tool ids currently attached and the ones the editor
// wants attached, plus any webhook names that would collide.
export function planAssistantToolSave(payload, { currentTools = [], libraryToolIds = new Set() } = {}) {
  const updatePayload = stripSharedToolsForAssistantUpdate(payload, libraryToolIds);
  const currentSharedToolIds = extractSharedToolIds(currentTools, libraryToolIds);
  const desiredSharedToolIds = extractSharedToolIds(payload?.tools, libraryToolIds);
  const attachedSharedNames = (Array.isArray(payload?.tools) ? payload.tools : [])
    .filter((tool) => isLibraryAssistantTool(tool, libraryToolIds))
    .map(getWebhookToolName)
    .filter(Boolean);
  const duplicateNames = findDuplicateWebhookToolNames(updatePayload.tools, attachedSharedNames);
  return { updatePayload, currentSharedToolIds, desiredSharedToolIds, duplicateNames };
}

export async function syncSharedToolAttachments(apiKey, { assistantId, currentToolIds, desiredToolIds }, { fetchImpl = fetch } = {}) {
  const attached = [];
  const detached = [];
  for (const toolId of desiredToolIds) {
    if (currentToolIds.has(toolId)) continue;
    await telnyxRequest(fetchImpl, apiKey, `/ai/assistants/${encodeURIComponent(assistantId)}/tools/${encodeURIComponent(toolId)}`, { method: "PUT" });
    attached.push(toolId);
  }
  for (const toolId of currentToolIds) {
    if (desiredToolIds.has(toolId)) continue;
    await telnyxRequest(fetchImpl, apiKey, `/ai/assistants/${encodeURIComponent(assistantId)}/tools/${encodeURIComponent(toolId)}`, { method: "DELETE" });
    detached.push(toolId);
  }
  return { attached, detached };
}

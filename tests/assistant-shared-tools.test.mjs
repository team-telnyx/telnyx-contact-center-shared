import assert from "node:assert/strict";
import test from "node:test";

import {
  extractSharedToolIds,
  findDuplicateWebhookToolNames,
  stripSharedToolsForAssistantUpdate,
} from "../lib/ai/tool-library.js";
import {
  fetchLibraryToolIds,
  planAssistantToolSave,
  syncSharedToolAttachments,
} from "../lib/ai/shared-tool-sync.mjs";

const inline = (name, id) => ({ tool_id: id, type: "webhook", shared: false, webhook: { name, url: "https://example.com/" + name } });
const shared = (name, id) => ({ tool_id: id, type: "webhook", shared: true, name: `Library ${name}`, webhook: { name, url: "https://cc.example.com/handoff" } });
const handoff = shared("cc_chat_handoff_8f5eea63fee1", "tool-handoff");

test("a shared tool returned inline by Telnyx is not sent back in the update payload", () => {
  const tools = [inline("get_offers", "tool-1"), handoff, { type: "hangup", tool_id: "tool-2", hangup: {} }];
  const stripped = stripSharedToolsForAssistantUpdate({ tools, name: "Léa" });
  assert.deepEqual(stripped.tools.map((tool) => tool.tool_id), ["tool-1", "tool-2"]);
  assert.equal(stripped.name, "Léa");
  assert.deepEqual([...extractSharedToolIds(tools)], ["tool-handoff"]);
  // Library membership known from the catalog also marks a tool as shared.
  assert.deepEqual([...extractSharedToolIds([inline("x", "tool-lib")], new Set(["tool-lib"]))], ["tool-lib"]);
});

test("the save plan reports duplicate webhook names before Telnyx does", () => {
  const plan = planAssistantToolSave({ tools: [inline("get_offers", "tool-1"), inline("get_offers", "tool-9"), handoff] }, { currentTools: [handoff] });
  assert.deepEqual(plan.duplicateNames, ["get_offers"]);
  // An inline copy of the attached shared tool's name collides as well.
  const copy = { type: "webhook", webhook: { name: "cc_chat_handoff_8f5eea63fee1", url: "https://x" } };
  assert.deepEqual(findDuplicateWebhookToolNames([copy], ["cc_chat_handoff_8f5eea63fee1"]), ["cc_chat_handoff_8f5eea63fee1"]);
  assert.deepEqual(findDuplicateWebhookToolNames([inline("a", "1"), inline("b", "2")], ["c"]), []);
});

test("attachments are added and removed to match the saved tools list", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  };
  const current = [inline("get_offers", "tool-1"), handoff, shared("legacy", "tool-old")];
  const desired = [inline("get_offers", "tool-1"), handoff, shared("new", "tool-new")];
  const plan = planAssistantToolSave({ tools: desired }, { currentTools: current });
  assert.deepEqual([...plan.currentSharedToolIds], ["tool-handoff", "tool-old"]);
  assert.deepEqual([...plan.desiredSharedToolIds], ["tool-handoff", "tool-new"]);
  const result = await syncSharedToolAttachments("key", { assistantId: "assistant-1", currentToolIds: plan.currentSharedToolIds, desiredToolIds: plan.desiredSharedToolIds }, { fetchImpl });
  assert.deepEqual(result, { attached: ["tool-new"], detached: ["tool-old"] });
  assert.deepEqual(calls, ["PUT /v2/ai/assistants/assistant-1/tools/tool-new", "DELETE /v2/ai/assistants/assistant-1/tools/tool-old"]);
});

test("the library catalog is paged and reduced to tool ids", async () => {
  const pages = { 1: Array.from({ length: 100 }, (_, index) => ({ id: `tool-${index}` })), 2: [{ id: "tool-100" }] };
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get("page[number]"));
    return new Response(JSON.stringify({ data: pages[page] || [] }), { status: 200 });
  };
  const ids = await fetchLibraryToolIds("key", { fetchImpl });
  assert.equal(ids.size, 101);
  assert.ok(ids.has("tool-100"));
});

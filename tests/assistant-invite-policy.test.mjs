import test from "node:test";
import assert from "node:assert/strict";
import { assistantInvitePolicy, hasSkipTurnTool, listInviteAssistants, inspectInviteAssistant, validateFlowAssistantInvites } from "../lib/ai/assistant-invite-policy.mjs";
const id = "assistant-00000000-0000-0000-0000-000000000001";
test("invites are opt-in, bounded, and preserve only assistant IDs", () => {
  assert.deepEqual(assistantInvitePolicy(), { enabled: false, assistantIds: [] });
  assert.deepEqual(assistantInvitePolicy({ enable_assistant_invite: true, invite_assistant_ids: [id, id, "sip:untrusted@example.test"] }), { enabled: true, assistantIds: [id] });
  assert.equal(assistantInvitePolicy({ enabled: false, enable_assistant_invite: true }).enabled, false);
});
test("Skip Turn validation resolves shared references and ignores detached expansions", async () => {
  assert.equal(await hasSkipTurnTool({ tools: [{ type: "skip_turn" }] }), true);
  assert.equal(await hasSkipTurnTool({ tools: [{ type: "skip_turn", tool_id: "removed" }], tool_ids: [] }), false);
  const paths = [];
  assert.equal(await hasSkipTurnTool({ tool_ids: ["shared"] }, async path => { paths.push(path); return { data: { type: "skip_turn" } }; }), true);
  assert.deepEqual(paths, ["/ai/tools/shared"]);
  await assert.rejects(hasSkipTurnTool({ tool_ids: ["unavailable"] }, async () => { throw Error("offline"); }), /offline/);
});
test("flow save checks every invited assistant and rejects missing tool or empty selection", async () => {
  const node = { data: { nodeType: "agent_assist", config: { enable_assistant_invite: true, invite_assistant_ids: [id] } } };
  await assert.rejects(validateFlowAssistantInvites([node], async () => ({ id, name: "Test", tools: [] })), /Skip Turn/);
  await validateFlowAssistantInvites([node], async () => ({ id, tools: [{ type: "skip_turn" }] }));
  node.data.config.invite_assistant_ids = [];
  await assert.rejects(validateFlowAssistantInvites([node], async () => assert.fail()), /at least one/);
});
test("catalog loads hundreds of names without assistant detail or tool requests", async () => {
  const calls = [];
  const items = await listInviteAssistants(async path => {
    calls.push(path);
    assert.ok(path.startsWith("/ai/assistants?page[number]="));
    const page = Number(new URL(path, "https://example.test").searchParams.get("page[number]"));
    return { data: Array.from({ length: 100 }, (_, index) => ({ id: `assistant-${page}-${index}`, name: `Assistant ${page}-${index}`, tools: [{ type: "skip_turn" }] })), meta: { total_pages: 3 } };
  }, { wait: async () => {} });
  assert.equal(items.length, 300); assert.equal(calls.length, 3);
  assert.deepEqual(Object.keys(items[0]).sort(), ["id", "name"]);
});
test("only the selected assistant is checked, with a fresh detail read", async () => {
  const calls = [];
  const request = async path => { calls.push(path); return { data: { id, name: "Orchid", tools: [{ type: "skip_turn" }] } }; };
  assert.deepEqual(await inspectInviteAssistant(id, request), { id, name: "Orchid", skipTurn: true });
  assert.deepEqual(calls, [`/ai/assistants/${id}`]);
  assert.equal((await inspectInviteAssistant(id, async () => ({ id, tools: [] }))).skipTurn, false);
  await assert.rejects(inspectInviteAssistant("../other", request), { status: 400 });
  assert.equal(calls.length, 1);
});
test("catalog retries provider rate limiting without hydrating details", async () => {
  const delays = []; let attempts = 0;
  const items = await listInviteAssistants(async path => {
    assert.ok(path.includes("page[number]"));
    if (++attempts === 1) throw Object.assign(Error("Rate limit"), { status: 429 });
    return { data: [{ id, name: "Orchid", tools: [] }] };
  }, { wait: async ms => delays.push(ms) });
  assert.deepEqual(items, [{ id, name: "Orchid" }]);
  assert.equal(attempts, 2);
  assert.ok(delays.includes(1000));
  await assert.rejects(listInviteAssistants(async () => { throw Object.assign(Error("Offline"), { status: 502 }); }, { wait: async () => {} }), /Offline/);
});

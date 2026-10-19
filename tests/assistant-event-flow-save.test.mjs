import test from "node:test";
import assert from "node:assert/strict";
import { prepareFlowAssistantInvites, saveFlowWithPreparedAssistants } from "../lib/ai/flow-assistant-events.mjs";
import { savedInviteAssistants } from "../lib/ai/assistant-invite-policy.mjs";
import { assistantEventDestinationConflict, assistantEventConfig } from "../lib/ai/assistant-event-config.mjs";
import { flowAssistantErrorPayload, ASSISTANT_EVENT_DESTINATION_CONFLICT } from "../lib/ai/assistant-event-conflicts.mjs";
import { SYSTEM_ROLES, PRESET_ROLES } from "../lib/authz/permissions.mjs";
import { effectiveAccess, can } from "../lib/authz/effective.mjs";
const first = "assistant-00000000-0000-0000-0000-000000000001", second = "assistant-00000000-0000-0000-0000-000000000002";
const config = { url: "wss://production.example.test/assistant-events", identifier: "test-secret", token: "test-token" };
const node = ids => ({ id: "assist", data: { nodeType: "agent_assist", config: { enabled: true, enable_assistant_invite: true, invite_assistant_ids: ids, other: "preserved" } } });
function fixture(overrides = {}) {
  const assistants = new Map([first, second].map((id, index) => [id, { id, name: `Assistant ${index}`, tools: [{ type: "skip_turn" }], ...overrides[id] }]));
  const calls = [];
  const secrets = new Set([config.identifier]);
  const request = async (path, options) => {
    calls.push({ path, options });
    if (path.startsWith("/integration_secrets")) {
      if (options?.body?.identifier) secrets.add(options.body.identifier);
      return { data: [...secrets].map(identifier => ({ identifier, type: "bearer" })) };
    }
    const id = path.split("/").at(-1), current = assistants.get(id);
    assert.ok(current);
    if (options) assistants.set(id, { ...current, ...options.body });
    return { data: structuredClone(assistants.get(id)) };
  };
  const locks = new Set();
  const pool = { async connect() {
    const owned = new Set();
    return {
      async query(sql, [id]) {
        if (sql.includes("pg_try_advisory_lock")) {
          if (locks.has(id)) return { rows: [{ acquired: false }] };
          locks.add(id); owned.add(id);
          return { rows: [{ acquired: true }] };
        }
        assert(sql.includes("pg_advisory_unlock"));
        assert(owned.delete(id)); locks.delete(id);
        return { rows: [] };
      },
      release() { assert.equal(owned.size, 0); },
    };
  } };
  return { assistants, calls, request, pool };
}
test("flow save prepares and independently verifies each unique selection, retaining names for runtime", async () => {
  const f = fixture(), nodes = [node([first, second]), node([first])];
  const saved = await prepareFlowAssistantInvites(nodes, f.request, { config, canUpdateAssistant: true });
  const writes = f.calls.filter(c => c.options);
  assert.equal(writes.length, 2);
  for (const write of writes) assert.deepEqual(write.options.body, { websocket_settings: { enabled: true, url: config.url, auth_ref: config.identifier } });
  assert.equal(f.calls.filter(c => c.path === `/ai/assistants/${first}` && !c.options).length, 3);
  assert.deepEqual(savedInviteAssistants(saved[0].data.config), [{ id: first, name: "Assistant 0" }, { id: second, name: "Assistant 1" }]);
  assert.equal(saved[0].data.config.other, "preserved");
  assert.equal(nodes[0].data.config.invite_assistants, undefined);
  await prepareFlowAssistantInvites(saved, f.request, { config, canUpdateAssistant: true });
  assert.equal(f.calls.filter(c => c.options).length, 2, "an unchanged save must not create another assistant version");
});
test("validate all selected tools and destinations before any provider write", async () => {
  for (const override of [{ tools: [] }, { websocket_settings: { enabled: true, url: "wss://different.example.test/observer" } }]) {
    const f = fixture({ [second]: override });
    await assert.rejects(prepareFlowAssistantInvites([node([first, second])], f.request, { config, canUpdateAssistant: true }));
    assert.equal(f.calls.filter(c => c.options).length, 0);
  }
});
test("an unverified provider write prevents a successful flow save", async () => {
  const f = fixture();
  const request = (path, options) => options ? { data: {} } : f.request(path);
  await assert.rejects(prepareFlowAssistantInvites([node([first])], request, { config, canUpdateAssistant: true }), /call flow was not saved.*could not be verified/);
});
test("disabled invitations need no provider settings and discard stale name snapshots", async () => {
  const disabled = node([first]); disabled.data.config.enable_assistant_invite = false;
  disabled.data.config.invite_assistants = [{ id: first, name: "Stale" }];
  const saved = await prepareFlowAssistantInvites([disabled], () => assert.fail("No provider request expected"));
  assert.deepEqual(saved[0].data.config.invite_assistants, []);
  assert.deepEqual(savedInviteAssistants({ invite_assistant_ids: [first], invite_assistants: [{ id: second, name: "Unselected" }] }), [{ id: first, name: first }]);
});

test("all conflicts are returned together, require explicit approval, and preserve unrelated assistant settings", async () => {
  const original = { enabled: true, url: "wss://dev.example.test/assistant-events", auth_ref: "dev-secret" };
  const f = fixture(Object.fromEntries([first, second].map(id => [id, { websocket_settings: original, instructions: "Preserve me", model: "test-model" }])));
  let conflict;
  await assert.rejects(prepareFlowAssistantInvites([node([first, second])], f.request, { config, canUpdateAssistant: true }), error => {
    conflict = flowAssistantErrorPayload(error);
    return error.status === 409 && error.code === ASSISTANT_EVENT_DESTINATION_CONFLICT;
  });
  assert.equal(conflict.conflicts.length, 2);
  assert.equal(f.calls.filter(c => c.options).length, 0);
  const confirmations = conflict.conflicts.map(({ assistantId, confirmationToken }) => ({ assistantId, confirmationToken }));
  await assert.rejects(prepareFlowAssistantInvites([node([first, second])], f.request, { config, canUpdateAssistant: true, confirmations: confirmations.slice(0, 1) }));
  assert.equal(f.calls.filter(c => c.options).length, 0, "partial consent cannot partially modify assistants");
  const saved = await prepareFlowAssistantInvites([node([first, second])], f.request, { config, canUpdateAssistant: true, confirmations });
  assert.equal(saved[0].data.config.invite_assistants.length, 2);
  for (const assistant of f.assistants.values()) {
    assert.equal(assistant.websocket_settings.url, config.url);
    assert.equal(assistant.instructions, "Preserve me");
    assert.equal(assistant.model, "test-model");
  }
  assert(!JSON.stringify(saved).includes("confirmationToken"));
});

test("consent cannot be reused after destination/auth changes or against another receiver or assistant", async () => {
  const original = { enabled: true, url: "wss://dev.example.test/assistant-events", auth_ref: "dev-secret" };
  for (const change of [
    a => { a.websocket_settings.url = "wss://third.example.test/events"; },
    a => { a.websocket_settings.auth_ref = "changed-secret"; },
  ]) {
    const f = fixture({ [first]: { websocket_settings: { ...original } } });
    const confirmation = assistantEventDestinationConflict(f.assistants.get(first), config);
    change(f.assistants.get(first));
    await assert.rejects(prepareFlowAssistantInvites([node([first])], f.request, { config, canUpdateAssistant: true, confirmations: [confirmation] }), { code: ASSISTANT_EVENT_DESTINATION_CONFLICT });
    assert.equal(f.calls.filter(c => c.options).length, 0);
  }
  const f = fixture({ [first]: { websocket_settings: original }, [second]: { websocket_settings: original } });
  const approval = assistantEventDestinationConflict(f.assistants.get(first), config);
  for (const [ids, receiver] of [[[second], config], [[first], { ...config, url: "wss://other-prod.example.test/events" }]]) {
    await assert.rejects(prepareFlowAssistantInvites([node(ids)], f.request, { canUpdateAssistant: true, config: receiver, confirmations: [approval] }), { code: ASSISTANT_EVENT_DESTINATION_CONFLICT });
  }
  assert.equal(f.calls.filter(c => c.options).length, 0);
});

test("another flow on the same instance reuses the shared destination without a prompt or provider write", async () => {
  const f = fixture();
  const receiver = assistantEventConfig({ WS_BASE_URL: "wss://cc.example.test/streaming", ASSISTANT_EVENT_SECRET: "a".repeat(32) });
  await prepareFlowAssistantInvites([node([first])], f.request, { canUpdateAssistant: true, config: receiver });
  f.calls.length = 0;
  await prepareFlowAssistantInvites([{ ...node([first]), id: "another-flow-node" }], f.request, { canUpdateAssistant: true, config: receiver });
  assert.equal(receiver.url, "wss://cc.example.test/assistant-events");
  assert.equal(f.calls.filter(c => c.options).length, 0);
});

test("conflict response hides credentials and generic errors expose no provider internals", () => {
  const conflict = assistantEventDestinationConflict({ id: first, websocket_settings: { enabled: true, url: "wss://user:password@dev.example.test/events?token=private#secret", auth_ref: "private-auth-ref" } }, config);
  const json = JSON.stringify(conflict);
  for (const secret of ["password", "user:", "token=private", "#secret", "private-auth-ref", config.token]) assert(!json.includes(secret));
  assert.match(conflict.currentUrl, /query\/fragment hidden/);
  const pathSecret = assistantEventDestinationConflict({ id: first, websocket_settings: { enabled: true, url: "wss://dev.example.test/events/private-path-credential" } }, config);
  assert(!JSON.stringify(pathSecret).includes("private-path-credential"));
  assert.match(pathSecret.currentUrl, /path hidden/);
  assert.deepEqual(flowAssistantErrorPayload({ message: "Provider unavailable", code: "UNRELATED", conflicts: ["private"] }), { ok: false, error: "Provider unavailable" });
});

test("routing-only administrators may reuse prepared assistants but cannot configure or replace their observer", async () => {
  const definitions = new Map([...SYSTEM_ROLES, ...PRESET_ROLES].map(role => [role.key, role]));
  const access = await effectiveAccess({ id: "routing-only", roles: ["routing-administrator"] }, definitions);
  assert.equal(can(access, "call_flows:update"), true);
  const canUpdateAssistant = can(access, "ai_assistants:update");
  assert.equal(canUpdateAssistant, false);
  for (const websocket_settings of [undefined, { enabled: true, url: "wss://other.example/events/private" }]) {
    const f = fixture({ [first]: { websocket_settings } });
    const approval = assistantEventDestinationConflict(f.assistants.get(first), config);
    await assert.rejects(prepareFlowAssistantInvites([node([first])], f.request, { config, canUpdateAssistant, confirmations: [approval] }), error => error.status === 403 && !error.conflicts && /ai_assistants:update/.test(error.message));
    assert.equal(f.calls.filter(call => call.options).length, 0);
  }
  const f = fixture({ [first]: { websocket_settings: { enabled: true, url: config.url, auth_ref: config.identifier } } });
  await prepareFlowAssistantInvites([node([first])], f.request, { config, canUpdateAssistant });
  assert.equal(f.calls.filter(call => call.options).length, 0);
});

test("a destination changed during secret lookup requires renewed consent before the provider write", async () => {
  const f = fixture({ [first]: { websocket_settings: { enabled: true, url: "wss://dev.example.test/assistant-events", auth_ref: "original" } } });
  const approval = assistantEventDestinationConflict(f.assistants.get(first), config);
  const request = async (path, options) => {
    if (path.startsWith("/integration_secrets")) f.assistants.get(first).websocket_settings = { enabled: true, url: "wss://new.example.test/assistant-events", auth_ref: "new" };
    return f.request(path, options);
  };
  await assert.rejects(prepareFlowAssistantInvites([node([first])], request, { config, canUpdateAssistant: true, confirmations: [approval] }), error => {
    assert.equal(error.code, ASSISTANT_EVENT_DESTINATION_CONFLICT);
    assert.equal(error.conflicts[0].currentUrl, "wss://new.example.test/assistant-events");
    assert.notEqual(error.conflicts[0].confirmationToken, approval.confirmationToken);
    return error.status === 409;
  });
  assert.equal(f.calls.filter(call => call.options).length, 0);
});

test("failed persistence restores every changed observer in reverse order", async () => {
  const original = { enabled: true, url: "wss://dev.example.test/assistant-events", auth_ref: "original" };
  const f = fixture({ [first]: { websocket_settings: original }, [second]: { websocket_settings: original } });
  const confirmations = [...f.assistants.values()].map(assistant => assistantEventDestinationConflict(assistant, config));
  await assert.rejects(saveFlowWithPreparedAssistants([node([first, second])], f.request, { pool: f.pool, config, canUpdateAssistant: true, confirmations }, async prepared => {
    assert.equal(prepared[0].data.config.invite_assistants.length, 2);
    assert([...f.assistants.values()].every(assistant => assistant.websocket_settings.url === config.url));
    throw new Error("Database unavailable");
  }), /Database unavailable.*settings were restored/);
  for (const assistant of f.assistants.values()) assert.deepEqual(assistant.websocket_settings, original);
  assert.deepEqual(f.calls.filter(call => call.options).slice(-2).map(call => call.path), [`/ai/assistants/${second}`, `/ai/assistants/${first}`]);
});

test("a later preparation failure compensates earlier successful assistant writes", async () => {
  const f = fixture();
  const request = async (path, options) => {
    if (path === `/ai/assistants/${second}` && options) throw new Error("Provider unavailable");
    return f.request(path, options);
  };
  await assert.rejects(saveFlowWithPreparedAssistants([node([first, second])], request, { pool: f.pool, config, canUpdateAssistant: true }, () => assert.fail("Must not persist")), /Provider unavailable.*settings were restored/);
  assert.equal(f.assistants.get(first).websocket_settings.enabled, false);
  assert.equal(f.assistants.get(second).websocket_settings, undefined);
});

test("rollback preserves a concurrent administrator change and reports incomplete restoration", async () => {
  const f = fixture();
  const concurrent = { enabled: true, url: "wss://third.example/events", auth_ref: "third" };
  await assert.rejects(saveFlowWithPreparedAssistants([node([first])], f.request, { pool: f.pool, config, canUpdateAssistant: true }, async () => {
    f.assistants.get(first).websocket_settings = concurrent;
    throw new Error("Persistence failed");
  }), error => error.status === 503 && /could not be restored.*Assistant 0/.test(error.message));
  assert.deepEqual(f.assistants.get(first).websocket_settings, concurrent);
  assert.equal(f.calls.filter(call => call.options).length, 1);
});

test("successful persistence retains provider settings without restoration", async () => {
  const f = fixture();
  assert.equal(await saveFlowWithPreparedAssistants([node([first])], f.request, { pool: f.pool, config, canUpdateAssistant: true }, async () => "saved"), "saved");
  assert.equal(f.assistants.get(first).websocket_settings.url, config.url);
  assert.equal(f.calls.filter(call => call.options).length, 1);
});


test("concurrent saves cannot commit an observer while another save may restore it", async () => {
  const f = fixture();
  const options = { pool: f.pool, config, canUpdateAssistant: true };
  let entered, finish;
  const writing = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { finish = resolve; });
  const firstSave = saveFlowWithPreparedAssistants([node([first])], f.request, options, async (_prepared, db) => {
    assert.equal(typeof db.query, "function");
    entered();
    await resume;
    throw new Error("First save failed");
  });
  const failed = assert.rejects(firstSave, /First save failed.*settings were restored/);
  await writing;
  const callCount = f.calls.length;
  await assert.rejects(saveFlowWithPreparedAssistants([node([first])], f.request, options, () => assert.fail("Concurrent write must not persist")), error => error.status === 409 && /Another call flow/.test(error.message));
  assert.equal(f.calls.length, callCount, "busy save must not read transient provider settings");
  finish();
  await failed;
  assert.equal(f.assistants.get(first).websocket_settings.enabled, false);
  assert.equal(await saveFlowWithPreparedAssistants([node([first])], f.request, options, async () => "saved after retry"), "saved after retry");
  assert.equal(f.assistants.get(first).websocket_settings.url, config.url);
});

test("a lost database acknowledgement never restores settings away from a potentially committed flow", async () => {
  for (const failure of [Object.assign(new Error("Connection reset"), { code: "ECONNRESET" }), new Error("Query read timeout")]) {
    const f = fixture();
    let stored;
    await assert.rejects(saveFlowWithPreparedAssistants([node([first])], f.request, { pool: f.pool, config, canUpdateAssistant: true }, async prepared => {
      stored = prepared;
      throw failure;
    }), error => error.status === 503 && /may already be saved.*settings were retained/.test(error.message));
    assert.equal(stored[0].data.config.invite_assistants[0].id, first);
    assert.equal(f.assistants.get(first).websocket_settings.url, config.url);
    assert.equal(f.calls.filter(call => call.options).length, 1);
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("phone fallback returns the newest call identity and clears every alias", async () => {
  const store = await import("../lib/incoming-call-store.js");
  store.clearAllIncomingCallData();

  const originalNow = Date.now;
  Date.now = () => 100_000;
  try {
    const oldCall = {
      interactionId: "interaction-old",
      callControlId: "transport-old",
      originalCallControlId: "customer-old",
      callSessionId: "session-old",
      fromNumber: "+48600000001",
      timestamp: 90_000,
    };
    const currentCall = {
      interactionId: "interaction-current",
      callControlId: "transport-current",
      originalCallControlId: "customer-current",
      callSessionId: "session-current",
      fromNumber: "+48600000001",
      timestamp: 99_000,
    };

    store.storeIncomingCallData("phone:+48600000001:old", oldCall);
    store.storeIncomingCallData("transport-old", oldCall);
    store.storeIncomingCallData("phone:+48600000001", currentCall);
    store.storeIncomingCallData("transport-current", currentCall);
    store.storeIncomingCallData("session:session-current", currentCall);

    assert.equal(
      store.getIncomingCallDataByPhone("+48 600 000 001")?.interactionId,
      "interaction-current",
    );

    store.clearIncomingCallData("interaction-current");
    assert.equal(store.getIncomingCallData("transport-current"), null);
    assert.equal(store.getIncomingCallData("session:session-current"), null);
    assert.equal(
      store.getIncomingCallDataByPhone("+48600000001")?.interactionId,
      "interaction-old",
    );
  } finally {
    Date.now = originalNow;
    store.clearAllIncomingCallData();
  }
});

test("calls store coalesces call legs and removes duplicates by any identity", async () => {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key),
  };
  const { default: callsStore } = await import("../lib/stores/calls-store.js");
  const state = callsStore.getState();
  state.clearAllCalls();

  state.addCall({
    callControlId: "transport-current",
    originalCallControlId: "customer-current",
    interactionId: "interaction-current",
    status: "ringing",
  });
  state.addCall({
    callControlId: "device-current",
    originalCallControlId: "customer-current",
    interactionId: "interaction-current",
    status: "connected",
  });

  const calls = Object.values(callsStore.getState().calls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "connected");
  assert.deepEqual(
    new Set(calls[0].callControlIds),
    new Set(["transport-current", "customer-current", "device-current"]),
  );
  assert.equal(state.getCall("device-current")?.interactionId, "interaction-current");

  callsStore.setState({
    calls: {
      ...callsStore.getState().calls,
      duplicate: {
        callControlId: "duplicate",
        interactionId: "interaction-current",
        status: "ringing",
      },
    },
  });
  state.removeCall("interaction-current");
  assert.equal(Object.keys(callsStore.getState().calls).length, 0);
});

test("ACD Core snapshots and transcription events use the shared browser lifecycle", async () => {
  const provider = await read(
    "components/contact-center/ContactCenterStreamProvider.jsx",
  );

  assert.match(provider, /data\.snapshot\.interactions/);
  assert.match(
    provider,
    /item\.terminal_at\s*\|\|\s*!item\.owns_live_assignment[\s\S]*removeCall\(item\.interaction_id\)/,
  );
  assert.match(
    provider,
    /String\(current\)\s*===\s*String\(item\.interaction_id\)[\s\S]*clearActiveCall\(\)/,
  );
  assert.match(
    provider,
    /applyCoreSnapshot\(data\.snapshot\)/,
  );
});

test("ACD Core media lifecycle is wired on the connection webhook", async () => {
  const route = await read("app/api/voice/webhook/route.js");
  const handler = await read("lib/acd/media-events.mjs");
  const router = await read("lib/agent-assist-transcription-router.mjs");

  assert.match(route, /handleAcdMediaEvent\(event\.eventType, event\.payload\)/);
  assert.match(handler, /routeAgentAssistTranscription\(payload\)/);
  assert.match(handler, /startAgentAssist/);
  assert.match(
    handler,
    /metadata\.telnyx_stt_config\?\.enabled[\s\S]*streamCallControlId = customerCallControlId/,
  );
  assert.match(handler, /stopAgentAssist/);
  assert.match(
    handler,
    /isAcdAgentMediaEvent[\s\S]*mediaSkipped:\s*true/,
  );
  assert.doesNotMatch(handler, /resolveAcdAgentMediaCallControlId/);
  assert.match(router, /findInteractionViewByCallControlId/);
  assert.match(router, /findInteractionViewByCallSessionId/);
});

test("wrap-up opens only from authoritative backend state and never replays old codes", async () => {
  const desktop = await read("components/contact-center/AgentDesktop.jsx");
  const global = await read("components/contact-center/GlobalWrapupSheet.jsx");
  const sheet = await read("components/contact-center/WrapupCodesSheet.jsx");
  const route = await read(
    "app/api/contact-center/interactions/[id]/wrapup/route.js",
  );

  assert.doesNotMatch(desktop, /\.openWrapup\(/);
  // Every delivery, reload and reconnect goes through one snapshot path. The
  // store identity check makes repeated snapshots idempotent.
  const opens = [...global.matchAll(/\.openWrapup\(/g)];
  assert.equal(opens.length, 1, "one Core snapshot path owns wrap-up presentation");
  assert.match(
    global,
    /!sheet\.open\s*\|\|\s*String\(sheet\.interactionId\)\s*!==\s*String\(pendingInteractionId\)/,
  );
  assert.match(global, /pending\.ended_at[\s\S]*!pending\.wrapup_ended_at/);
  assert.doesNotMatch(global, /wrapup_required|status_changed/);
  // The contract is that the sheet remounts per interaction so stale codes cannot
  // replay; further discriminators may precede it (segmentId does today).
  assert.match(global, /key=\{[^}]*interactionId \|\| "closed"\}/);
  assert.doesNotMatch(sheet, /action:\s*"start"/);
  assert.match(sheet, /action:\s*"end"/);
  assert.match(sheet, /data-testid="wrapup-submit-break"/);
  assert.match(sheet, /Save & Go on Break/);
  assert.match(sheet, /nextStatus:\s*"Break"/);
  assert.match(route, /findPendingAcdWrapupSegment/);
  assert.match(route, /completeAcdWrapup/);
  assert.match(route, /No pending wrap-up belongs to this agent/);
});

test("Agent Desktop requires exact WebRTC identity and the agent API uses Core ownership", async () => {
  const list = await read("components/contact-center/InteractionsList.jsx");
  const route = await read("app/api/contact-center/agent/interactions/route.js");

  assert.doesNotMatch(list, /Fallback: For inbound calls/);
  assert.match(list, /matchesInteractionCall\(interaction, webrtcCallState\)/);
  const { matchesInteractionCall } = await import("../lib/telephony/interaction-controls.mjs");
  assert.equal(matchesInteractionCall({id:"other",direction:"outbound"},{call:{id:"active"},direction:"outbound",contactCenter:{interactionId:"current"}}),false);
  assert.match(
    route,
    /listAgentInteractionViews\(pool, user\.id/,
  );
});

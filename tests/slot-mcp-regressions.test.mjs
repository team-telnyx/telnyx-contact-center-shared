import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  candidateGenerationId,
  createMcpCandidateToken,
  isMcpCandidateToken,
  parseMcpCandidateToken,
} from "../lib/agent-assist/mcp-candidate-token.mjs";
import {
  bindingKey,
  collapseSingleAlternative,
  collectDerivedClosure,
  collectSlotMcpBindings,
  normalizeSlotMcpBinding,
} from "../lib/agent-assist/slot-mcp-runner.mjs";
import { orchestrateSlotMcpBindings } from "../lib/agent-assist/slot-mcp-orchestrator.mjs";

const root = new URL("../", import.meta.url);

function oncePerSessionBinding() {
  return collectSlotMcpBindings([
    {
      item_id: "submit-item",
      slot_name: "transport_created",
      mcp_binding: {
        server_id: "srv-intake",
        tool_name: "create_transport",
        trigger: "on_complete",
        execution_policy: "once_per_session",
        result_key: "created",
        arguments: { requestId: "stable-request" },
        outputs: { trip_id: "trip_id" },
      },
    },
  ]);
}

function manualSubmitBinding() {
  return collectSlotMcpBindings([
    {
      item_id: "submit-item",
      slot_name: "transport_created",
      mcp_binding: {
        server_id: "srv-intake",
        tool_name: "create_transport",
        trigger: "manual_submit",
        result_key: "created",
        arguments: { pickupId: "{{slots.pickup_facility_id}}" },
        outputs: { trip_id: "trip_id" },
      },
    },
  ]);
}

function claimedSession() {
  const runs = {};
  return {
    runs,
    claim: async (key, fingerprint) => {
      if (runs[key] !== undefined) return { claimed: false };
      runs[key] = fingerprint;
      return { claimed: true };
    },
    release: async (key) => {
      delete runs[key];
    },
  };
}

test("MCP candidate tokens preserve opaque generation identity and exact index", () => {
  const fingerprint = JSON.stringify(["binding", [["address", "123 Patient St"]]]);
  const token = createMcpCandidateToken({
    resultKey: "pickup_lookup",
    generation: fingerprint,
    candidateIndex: 2,
  });

  assert.equal(isMcpCandidateToken(token), true);
  assert.deepEqual(parseMcpCandidateToken(token), {
    resultKey: "pickup_lookup",
    generationId: candidateGenerationId(fingerprint),
    candidateIndex: 2,
  });
  assert.ok(!token.includes("Patient"), "resolved MCP arguments must not leak through the browser token");
  assert.equal(parseMcpCandidateToken("[object Object]"), null);
  assert.equal(parseMcpCandidateToken("__mcp_candidate__:garbage"), null);
});

test("duplicate candidate business values still have distinct identities", () => {
  const first = createMcpCandidateToken({ resultKey: "lookup", generation: "g", candidateIndex: 0 });
  const second = createMcpCandidateToken({ resultKey: "lookup", generation: "g", candidateIndex: 1 });
  assert.notEqual(first, second);
  assert.equal(parseMcpCandidateToken(first).candidateIndex, 0);
  assert.equal(parseMcpCandidateToken(second).candidateIndex, 1);
});

test("a definite once-per-session tool error releases the claim for retry", async () => {
  const session = claimedSession();
  let calls = 0;
  const run = () => orchestrateSlotMcpBindings({
    bindings: oncePerSessionBinding(),
    requiredSlots: [],
    completedRuns: session.runs,
    manualSubmitItemId: "submit-item",
    deps: {
      claim: session.claim,
      release: session.release,
      callTool: async () => {
        calls += 1;
        return { payload: null, error: "the reference workflow validation failed" };
      },
    },
  });

  const first = await run();
  assert.equal(first.invocations[0].retryable, true);
  assert.deepEqual(session.runs, {});
  await run();
  assert.equal(calls, 2, "a definite failure should be attempted again later");
});

test("a preflight once-per-session failure releases the claim for retry", async () => {
  const session = claimedSession();
  let calls = 0;
  const run = () => orchestrateSlotMcpBindings({
    bindings: oncePerSessionBinding(),
    requiredSlots: [],
    completedRuns: session.runs,
    manualSubmitItemId: "submit-item",
    deps: {
      claim: session.claim,
      release: session.release,
      callTool: async () => {
        calls += 1;
        const error = new Error("MCP tool is not discovered for this server");
        error.mcpDispatchState = "preflight";
        error.remoteOutcomeUncertain = false;
        throw error;
      },
    },
  });

  const first = await run();
  assert.equal(first.invocations[0].retryable, true);
  assert.equal(first.invocations[0].dispatch_state, "preflight");
  assert.equal(first.invocations[0].uncertain_remote_outcome, false);
  assert.deepEqual(session.runs, {}, "preflight failure cannot have executed the remote side effect");

  await run();
  assert.equal(calls, 2, "correcting a preflight/configuration failure must allow a later retry");
});

test("an uncertain once-per-session transport error keeps the claim", async () => {
  const session = claimedSession();
  let calls = 0;
  const run = () => orchestrateSlotMcpBindings({
    bindings: oncePerSessionBinding(),
    requiredSlots: [],
    completedRuns: session.runs,
    manualSubmitItemId: "submit-item",
    deps: {
      claim: session.claim,
      release: session.release,
      callTool: async () => {
        calls += 1;
        throw new Error("socket closed after request write");
      },
    },
  });

  const first = await run();
  assert.equal(first.invocations[0].retryable, false);
  assert.equal(first.invocations[0].uncertain_remote_outcome, true);
  assert.equal(Object.keys(session.runs).length, 1, "claim stays parked for reconciliation");

  const second = await run();
  assert.equal(second.invocations.length, 0);
  assert.equal(calls, 1, "must not repeat a possibly-successful create_transport");
});

test("derived invalidation preserves once-per-session descendant run markers", () => {
  const bindings = collectSlotMcpBindings([
    {
      item_id: "lookup-item",
      slot_name: "pickup_location",
      mcp_binding: {
        server_id: "srv",
        tool_name: "lookup",
        trigger: "on_fill",
        result_key: "lookup_result",
        outputs: { facility_id: "facility_id" },
      },
    },
    {
      item_id: "submit-item",
      slot_name: "submitted",
      mcp_binding: {
        server_id: "srv",
        tool_name: "submit_once",
        trigger: "on_result",
        depends_on: "lookup_result",
        execution_policy: "once_per_session",
        result_key: "submit_result",
        outputs: { remote_id: "id" },
      },
    },
    {
      item_id: "enrich-item",
      slot_name: "post_submit_enrichment",
      mcp_binding: {
        server_id: "srv",
        tool_name: "enrich",
        trigger: "on_result",
        depends_on: "submit_result",
        result_key: "enriched",
        outputs: { enriched_value: "value" },
      },
    },
  ]);

  const closure = collectDerivedClosure(bindings, bindings[0]);
  const submitKey = bindingKey(bindings[1]);
  const enrichKey = bindingKey(bindings[2]);

  assert.ok(closure.resultKeys.includes("submit_result"), "once-only descendant result is still stale data");
  assert.ok(closure.slots.includes("remote_id"), "once-only descendant outputs are still invalidated");
  assert.ok(!closure.bindingKeys.includes(submitKey), "once-only side-effect claim must survive ancestor correction");
  assert.ok(closure.bindingKeys.includes(enrichKey), "traversal must continue and retire normal descendants");
});

test("derived invalidation follows on-fill bindings owned by produced slots", () => {
  const bindings = collectSlotMcpBindings([
    {
      item_id: "lookup-item",
      slot_name: "pickup_location",
      mcp_binding: {
        server_id: "srv",
        tool_name: "lookup",
        trigger: "on_fill",
        result_key: "lookup_result",
        outputs: { facility_id: "facility_id" },
      },
    },
    {
      item_id: "facility-enrich-item",
      slot_name: "facility_id",
      mcp_binding: {
        server_id: "srv",
        tool_name: "enrich_facility",
        trigger: "on_fill",
        result_key: "facility_enrichment",
        outputs: { facility_region: "region" },
      },
    },
  ]);

  const closure = collectDerivedClosure(bindings, bindings[0]);
  assert.ok(closure.slots.includes("facility_id"), "root-produced slot must be invalidated");
  assert.ok(closure.slots.includes("facility_region"), "on-fill descendant output must be invalidated");
  assert.ok(closure.resultKeys.includes("facility_enrichment"), "on-fill descendant result must be invalidated");
  assert.ok(closure.bindingKeys.includes(bindingKey(bindings[1])), "on-fill descendant run marker must be retired");
});

test("empty result keys fall back to the tool name", () => {
  const binding = normalizeSlotMcpBinding({
    server_id: "srv",
    tool_name: "lookup_addresses",
    result_key: "   ",
  });
  assert.equal(binding?.result_key, "lookup_addresses");
});

test("blank alternative targets do not turn a trigger/input slot into an MCP output", () => {
  const binding = normalizeSlotMcpBinding({
    server_id: "srv",
    tool_name: "lookup_addresses",
    alternatives: {
      path: "$",
      value: "{{facility_id}}",
      target_slot: "",
    },
  });

  assert.deepEqual(
    collapseSingleAlternative(binding, [{ value: "2566" }], "pickup_location"),
    {},
    "a display fallback must not authorize MCP to replace pickup_location",
  );

  const explicit = normalizeSlotMcpBinding({
    server_id: "srv",
    tool_name: "lookup_addresses",
    alternatives: {
      path: "$",
      value: "{{facility_id}}",
      target_slot: "pickup_facility_id",
    },
  });
  assert.deepEqual(
    collapseSingleAlternative(explicit, [{ value: "2566" }], "pickup_location"),
    { pickup_facility_id: "2566" },
  );
});

test("manual submit normalizes to once-per-session", () => {
  const binding = normalizeSlotMcpBinding({
    server_id: "srv",
    tool_name: "create_transport",
    trigger: "manual_submit",
  });
  assert.equal(binding?.trigger, "manual_submit");
  assert.equal(binding?.execution_policy, "once_per_session");
});

test("manual submit never runs during a normal MCP pass", async () => {
  const bindings = manualSubmitBinding();
  let calls = 0;
  const result = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_facility_id: "2566" },
    requiredSlots: ["pickup_facility_id", "transport_created"],
    deps: {
      callTool: async () => {
        calls += 1;
        return { payload: { trip_id: "trip-1" }, error: null };
      },
    },
  });
  assert.equal(calls, 0, "filling the final slot must not create a transport");
  assert.equal(result.invocations.length, 0);
});

test("manual submit runs only when explicitly confirmed and all inputs are ready", async () => {
  const bindings = manualSubmitBinding();
  const session = claimedSession();
  let calls = 0;
  const options = {
    bindings,
    slotsFilled: { pickup_facility_id: "2566" },
    requiredSlots: ["pickup_facility_id", "transport_created"],
    completedRuns: session.runs,
    manualSubmitItemId: "submit-item",
    deps: {
      claim: session.claim,
      release: session.release,
      callTool: async () => {
        calls += 1;
        return { payload: { trip_id: "trip-1" }, error: null };
      },
    },
  };

  const first = await orchestrateSlotMcpBindings(options);
  assert.equal(calls, 1);
  assert.equal(first.invocations[0]?.ok, true);
  assert.equal(first.slotUpdates.trip_id, "trip-1");

  await orchestrateSlotMcpBindings(options);
  assert.equal(calls, 1, "confirmed create_transport remains once-per-session");
});

test("manual submit stays blocked when a required input is missing", async () => {
  const bindings = manualSubmitBinding();
  let calls = 0;
  const result = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: {},
    requiredSlots: ["pickup_facility_id", "transport_created"],
    manualSubmitItemId: "submit-item",
    deps: {
      callTool: async () => {
        calls += 1;
        return { payload: { trip_id: "trip-1" }, error: null };
      },
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.invocations.length, 0);
});

test("selection reconstruction normalizes bracket notation", async () => {
  const source = await readFile(new URL("lib/agent-assist/slot-mcp-execute.js", root), "utf8");
  assert.ok(source.includes(String.raw`.replace(/\[(\d+)\]/g, ".$1")`));
  assert.match(source, /const parts = normalizePathSegments\(path\)/);
});

test("manual values bypass MCP candidate selection; only tokens enter it", async () => {
  const source = await readFile(new URL("lib/agent-assist/slot-mcp-execute.js", root), "utf8");
  assert.match(source, /const token = parseMcpCandidateToken\(value\)/);
  assert.match(source, /if \(!token\) return none/);
  assert.match(source, /record\.item_id !== itemId/);
  assert.match(source, /token\.candidateIndex/);
  assert.match(source, /candidateGenerationId\(record\.generation\) !== token\.generationId/);
  assert.ok(!source.includes("String(candidateValue) === String(value)"));
});

test("candidate selection writes only an explicitly configured target plus declared outputs", async () => {
  const source = await readFile(new URL("lib/agent-assist/slot-mcp-execute.js", root), "utf8");
  const orchestrator = await readFile(new URL("lib/agent-assist/slot-mcp-orchestrator.mjs", root), "utf8");
  assert.match(
    source,
    /const targetSlot = record\.target_slot \|\| binding\?\.alternatives\?\.target_slot \|\| null/,
  );
  assert.match(source, /const slotUpdates = targetSlot\s*\n\s*\? \{ \.\.\.mappedUpdates, \[targetSlot\]: selectedValue \}\s*\n\s*: mappedUpdates/);
  assert.match(orchestrator, /targetSlot: binding\.alternatives\?\.target_slot \|\| null/);
  assert.ok(
    !/targetSlot: binding\.alternatives\?\.target_slot \|\| slotName/.test(orchestrator),
    "the owning/display slot is not an implicit MCP write target",
  );
});

test("structured argument schema types are parsed before template fallback", async () => {
  const source = await readFile(new URL("components/admin/SlotMcpBindingEditor.jsx", root), "utf8");
  const structured = source.indexOf('if (declared === "object" || declared === "array")');
  const templateFallback = source.indexOf('else if (declared === "string" || raw.includes("{{"))');
  assert.ok(structured >= 0 && templateFallback > structured);
  assert.match(source, /const parsed = JSON\.parse\(raw\)/);
});

test("MCP selections do not create permanent manual edit fences in the store", async () => {
  const source = await readFile(new URL("lib/stores/workflow-store.js", root), "utf8");
  assert.match(source, /const isMcpSelection = isMcpCandidateToken\(value\)/);
  assert.match(source, /if \(!isMcpSelection\) \{/);
  assert.match(source, /if \(data\.mcpSelectionResolved\) \{/);
  assert.match(source, /delete nextItemEdits\[itemId\]/);
  assert.match(source, /delete nextSlotEdits\[slotName\]/);
});

test("manual slot-summary edits retire parked MCP candidates atomically", async () => {
  const source = await readFile(new URL("app/api/agent-assist/workflow/slot/[name]/route.js", root), "utf8");
  const begin = source.indexOf('await client.query("BEGIN")');
  const manualWrite = source.indexOf("completed_by = 'agent'", begin);
  const candidateClear = source.indexOf("mcp_candidates = COALESCE(mcp_candidates", manualWrite);
  const candidateOwner = source.indexOf("value ->> 'item_id' = $2", candidateClear);
  const commit = source.indexOf('await client.query("COMMIT")', candidateClear);

  assert.ok(begin >= 0 && manualWrite > begin, "manual slot update must execute in a transaction");
  assert.ok(candidateClear > manualWrite, "manual edit must retire any parked MCP candidate generation");
  assert.ok(candidateOwner > candidateClear, "candidate retirement must be scoped to the edited item");
  assert.ok(commit > candidateOwner, "candidate retirement and agent ownership must commit atomically");
});

test("startup always runs one MCP pass after prefill and AI handoff", async () => {
  const source = await readFile(new URL("app/api/agent-assist/workflow/start/route.js", root), "utf8");
  const prefillCommit = source.indexOf('await client.query("COMMIT")');
  const handoffApply = source.indexOf("aiHandoffData = await applyPendingAiHandoff", prefillCommit);
  const mcpRun = source.indexOf("await runAndPersistSlotMcpBindings", handoffApply);
  const finalState = source.indexOf("const sessionState = await getWorkflowSessionState", mcpRun);

  assert.match(source, /import \{ runAndPersistSlotMcpBindings \} from "@\/lib\/agent-assist\/slot-mcp-execute"/);
  assert.ok(prefillCommit >= 0 && handoffApply > prefillCommit, "AI handoff must apply after the startup transaction commits");
  assert.ok(mcpRun > handoffApply, "startup MCP must run after pending AI handoff is applied");
  assert.ok(finalState > mcpRun, "initial response must be fetched after startup MCP persistence");
  assert.ok(
    !source.includes("if (workflowPrefill.itemCompletions.length > 0 || aiHandoffApplied)"),
    "startup MCP must not depend on prefill/handoff because input-free on_complete bindings are already eligible",
  );
});

test("reopening derived items clears stale MCP provenance and suggestion metadata", async () => {
  const source = await readFile(new URL("lib/agent-assist/slot-mcp-execute.js", root), "utf8");
  const claimStart = source.indexOf("async function claimInvocation(");
  const claimEnd = source.indexOf("\nasync function releaseInvocation(", claimStart);
  const persistStart = source.indexOf("export async function persistMcpSlotUpdates(");
  const completeItemStart = source.indexOf("const completeItem = async", persistStart);

  for (const [label, body] of [
    ["claim-time reopen", source.slice(claimStart, claimEnd)],
    ["persist-time reopen", source.slice(persistStart, completeItemStart)],
  ]) {
    assert.match(body, /SET status = 'pending',[\s\S]*?completed_by = NULL/,
      `${label} must retire stale MCP ownership`);
    assert.match(body, /confidence_score = NULL/,
      `${label} must clear stale confidence metadata`);
    assert.match(body, /alternatives = NULL/,
      `${label} must clear stale suggestion choices`);
    assert.match(body, /source_transcript = NULL/,
      `${label} must clear stale transcript provenance`);
    assert.match(body, /is_correction = FALSE/,
      `${label} must clear stale correction metadata`);
    assert.match(body, /is_manual_edit = FALSE/,
      `${label} must not leave a derived row marked as a manual edit`);
  }
});

test("new transport manual submit is confirmed in the workflow UI", async () => {
  const host = await readFile(new URL("components/contact-center/InteractionDetail.jsx", root), "utf8");
  const control = await readFile(new URL("components/contact-center/TransportMcpSubmitControl.jsx", root), "utf8");
  const route = await readFile(new URL("app/api/agent-assist/workflow/mcp-submit/route.js", root), "utf8");

  assert.match(host, /<TransportMcpSubmitControl \/>/);
  assert.match(control, /Confirm new transport request/);
  assert.match(control, /Confirm & submit new transport/);
  assert.match(control, /\/api\/agent-assist\/workflow\/mcp-submit/);
  assert.match(route, /\[BINDING_TRIGGERS\.MANUAL_SUBMIT, BINDING_TRIGGERS\.ON_COMPLETE\]\.includes\(binding\.trigger\)/);
  assert.match(route, /binding\.tool_name !== "create_transport"/);
  assert.match(route, /manualSubmitItemId: itemId/);
});
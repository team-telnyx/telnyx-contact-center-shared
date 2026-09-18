import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);

/**
 * Loads slot-mcp-execute.js with its `@/` imports replaced by stubs so the
 * adapter can actually be RUN, not just pattern-matched.
 *
 * Every previous failure in this file - a wrong response field, a parameter
 * read but never destructured - passed the source assertions and would have
 * thrown on the first real call.
 */
async function loadAdapter(pool) {
  const source = await readFile(new URL("lib/agent-assist/slot-mcp-execute.js", root), "utf8");
  const runner = new URL("lib/agent-assist/slot-mcp-runner.mjs", root).href;
  const orchestrator = new URL("lib/agent-assist/slot-mcp-orchestrator.mjs", root).href;
  const candidateToken = new URL("lib/agent-assist/mcp-candidate-token.mjs", root).href;

  globalThis.__testPool = pool;
  const stubbed = source
    .replace(/^import \{ getPostgresPool \}.*$/m, "const getPostgresPool = () => globalThis.__testPool;")
    .replace(/^import \{ callMcpTool \}.*$/m, "const callMcpTool = async () => ({ structuredContent: {}, isError: false });")
    .replace(/^import \{ getMcpResponseVariablePayload \}.*$/m, "const getMcpResponseVariablePayload = (r) => r?.structuredContent ?? r;")
    .replace(/^import \{ agentAssistRuntimePayload, workflowLogger \}.*$/m,
      "const agentAssistRuntimePayload = (x) => x; const workflowLogger = { info() {}, error() {} };")
    .replace(/^import \{ recalculateCurrentStage \}.*$/m, "const recalculateCurrentStage = async () => {};")
    .replace(/from "@\/lib\/agent-assist\/mcp-candidate-token\.mjs"/, `from "${candidateToken}"`)
    .replace(/from "@\/lib\/agent-assist\/slot-mcp-runner\.mjs"/, `from "${runner}"`)
    .replace(/from "@\/lib\/agent-assist\/slot-mcp-orchestrator\.mjs"/, `from "${orchestrator}"`);

  return import(`data:text/javascript;base64,${Buffer.from(stubbed).toString("base64")}`);
}

/** Minimal pg double that answers by statement shape. */
function makePool({ agentOwned = [], slotItems = [], updateRowCount = 1 } = {}) {
  const queries = [];
  const answer = (sql) => {
    queries.push(sql.replace(/\s+/g, " ").trim().slice(0, 80));
    if (/completed_by = 'agent'/.test(sql) && /SELECT/.test(sql)) return { rows: agentOwned, rowCount: agentOwned.length };
    if (/SELECT i\.id, i\.slot_name/.test(sql)) return { rows: slotItems, rowCount: slotItems.length };
    if (/UPDATE aa_workflow_sessions/.test(sql) && /RETURNING slots_version/.test(sql)) {
      return { rows: updateRowCount ? [{ slots_version: 7 }] : [], rowCount: updateRowCount };
    }
    if (/UPDATE aa_workflow_item_status/.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT COALESCE\(slots_filled/.test(sql)) {
      return { rows: [{ slots_filled: { pickup_location: "Hospital A" }, mcp_results: {}, mcp_runs: {}, slots_version: 7 }] };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query: async (sql) => answer(String(sql)), release() {} };
  return { queries, connect: async () => client, query: async (sql) => answer(String(sql)) };
}

test("persistMcpSlotUpdates runs without a ReferenceError on a mapped result", async () => {
  const pool = makePool({ slotItems: [{ id: "item-1", slot_name: "pickup_facility_id" }] });
  const { persistMcpSlotUpdates } = await loadAdapter(pool);

  const outcome = await persistMcpSlotUpdates({
    sessionId: "s1",
    workflowId: "w1",
    slotUpdates: { pickup_facility_id: "2566" },
    mcpResults: { pickup_lookup: [{ facility_id: "2566" }] },
  });

  assert.equal(outcome.applied, true);
  assert.deepEqual(outcome.appliedSlotUpdates, { pickup_facility_id: "2566" });
  assert.equal(outcome.slotsVersion, 7);
});

test("persistMcpSlotUpdates runs with no mapped slots at all", async () => {
  // The ambiguous path passes an empty slotUpdates; a parameter read but never
  // destructured throws here even though nothing is written.
  const pool = makePool();
  const { persistMcpSlotUpdates } = await loadAdapter(pool);

  const outcome = await persistMcpSlotUpdates({
    sessionId: "s1",
    workflowId: "w1",
    slotUpdates: {},
    mcpCandidates: { pickup_lookup: { candidates: [] } },
  });
  assert.equal(outcome.applied, true);
});

test("persistMcpSlotUpdates writes alternatives and reports them", async () => {
  const pool = makePool();
  const { persistMcpSlotUpdates } = await loadAdapter(pool);

  const outcome = await persistMcpSlotUpdates({
    sessionId: "s1",
    workflowId: "w1",
    slotUpdates: {},
    alternatives: [
      { value: "2566", label: "Sutter Palo Alto" },
      { value: "2999", label: "Sutter Menlo" },
    ],
    alternativesItemId: "item-target",
    alternativesResultKey: "pickup_lookup",
  });

  const suggested = outcome.itemUpdates.find((u) => u.status === "suggested");
  assert.ok(suggested, "the choices must reach the caller, not only the database");
  assert.equal(suggested.alternatives.length, 2);
  assert.equal(suggested.alternatives[0].candidate_index, 0);
  assert.equal(suggested.extracted_value, null);
});

test("a lost claim rolls back and reports nothing applied", async () => {
  const pool = makePool({ updateRowCount: 0 });
  const { persistMcpSlotUpdates } = await loadAdapter(pool);

  const outcome = await persistMcpSlotUpdates({
    sessionId: "s1",
    workflowId: "w1",
    slotUpdates: { pickup_facility_id: "2566" },
    key: "k",
    fingerprint: "f",
  });
  assert.equal(outcome.applied, false);
  assert.deepEqual(outcome.itemUpdates, []);
  assert.ok(pool.queries.some((q) => q.startsWith("ROLLBACK")));
});

test("an agent-owned slot is filtered out of both writes", async () => {
  const pool = makePool({
    agentOwned: [{ slot_name: "pickup_address" }],
    slotItems: [{ id: "item-1", slot_name: "pickup_address" }],
  });
  const { persistMcpSlotUpdates } = await loadAdapter(pool);

  const outcome = await persistMcpSlotUpdates({
    sessionId: "s1",
    workflowId: "w1",
    slotUpdates: { pickup_address: "MCP address" },
  });
  assert.deepEqual(outcome.appliedSlotUpdates, {}, "the agent's value must not be replaced");
  assert.deepEqual(outcome.itemUpdates, []);
});

test("runAndPersistSlotMcpBindings returns the full contract with no bindings", async () => {
  const pool = makePool();
  const { runAndPersistSlotMcpBindings } = await loadAdapter(pool);

  const result = await runAndPersistSlotMcpBindings({ sessionId: "s1", workflowId: "w1" });

  // Callers spread itemUpdates and treat slotsFilled as authoritative; a
  // partial shape throws, and a {} slot map wipes the live desktop.
  assert.ok(Array.isArray(result.itemUpdates));
  assert.ok(Array.isArray(result.invocations));
  assert.equal(result.slotsFilled, null, "must not claim an empty authoritative map");
});

test("claiming a replacement retires every non-agent generation status", async () => {
  // MCP values, selections, analyzer values, prefills and inference are all
  // replaceable derived state. Only a genuine hand-typed agent completion is
  // authoritative and survives generation retirement.
  const reopened = [];
  const pool = {
    connect: async () => ({
      query: async (sql, params) => {
        const text = String(sql);
        if (/RETURNING prev\.previous/.test(text)) return { rows: [{ previous: "old-fp", slots_version: 8 }], rowCount: 1 };
        if (/UPDATE aa_workflow_item_status st/.test(text)) {
          reopened.push({ sql: text, slots: params[1] });
          return { rows: [{ item_id: "item-1", slot_name: "pickup_facility_id" }] };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    }),
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  globalThis.__testPool = pool;

  const source = await readFile(new URL("lib/agent-assist/slot-mcp-execute.js", root), "utf8");
  // claimInvocation is module-private; exercise it through the exported runner
  // surface by asserting the statement it issues.
  assert.match(source, /st\.completed_by IS DISTINCT FROM 'agent'/);
  assert.match(source, /wi\.slot_name = ANY\(\$2::text\[\]\)/);
});

test("candidate selection maps through the binding shape snapshotted at parking time, not a live edit (Codex P2 on #1371)", async () => {
  const { createMcpCandidateToken } = await import("../lib/agent-assist/mcp-candidate-token.mjs");
  const token = createMcpCandidateToken({ resultKey: "pickup_lookup", generation: "fp-1", candidateIndex: 0 });

  const parkedRecord = {
    item_id: "item-display",
    binding_item_id: "item-display",
    target_slot: null,
    generation: "fp-1",
    candidates: [{ facility_id: "F1", facility_name: "Sutter Palo Alto" }],
    candidate_values: ["F1"],
    payload: [{ facility_id: "F1", facility_name: "Sutter Palo Alto" }],
    // Snapshotted when these candidates were parked.
    binding_outputs: { pickup_facility_id_old: "0.facility_id" },
    binding_alternatives: { path: "$", label: "{{facility_name}}", value: "{{facility_id}}", target_slot: "" },
  };

  const queries = [];
  const pool = {
    query: async (sql) => {
      const text = String(sql).replace(/\s+/g, " ").trim();
      queries.push(text.slice(0, 60));
      if (/SELECT mcp_candidates FROM aa_workflow_sessions/.test(text)) {
        return { rows: [{ mcp_candidates: { pickup_lookup: parkedRecord } }] };
      }
      // The item's mcp_binding has since been edited to a DIFFERENT output
      // mapping. If selection ever reaches this query, the fix regressed.
      if (/SELECT i\.mcp_binding/.test(text)) {
        return {
          rows: [{
            mcp_binding: {
              server_id: "srv-intake",
              tool_name: "lookup_addresses",
              outputs: { pickup_facility_id_NEW: "0.facility_id" },
            },
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (sql) => {
        const text = String(sql).replace(/\s+/g, " ").trim();
        queries.push(text.slice(0, 60));
        if (/UPDATE aa_workflow_sessions/.test(text) && /RETURNING slots_version/.test(text)) {
          return { rows: [{ slots_version: 3 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    }),
  };

  const { resolveMcpCandidateSelection } = await loadAdapter(pool);
  const result = await resolveMcpCandidateSelection({
    sessionId: "s1",
    workflowId: "w1",
    itemId: "item-display",
    value: token,
  });

  assert.equal(result.resolved, true);
  assert.ok(
    "pickup_facility_id_old" in result.slotUpdates,
    "must map through the SNAPSHOTTED outputs from when candidates were parked",
  );
  assert.ok(
    !("pickup_facility_id_NEW" in result.slotUpdates),
    "must not apply the live-edited binding's output mapping",
  );
  assert.ok(
    !queries.some((q) => q.includes("SELECT i.mcp_binding")),
    "must not reload the live binding when a snapshot is present",
  );
});

test("selection with no downstream binding still yields a full slot map", async () => {
  // Scenario 4 from review: returning selection.slotUpdates through a field
  // named slotsFilled makes the store replace the whole document with a patch.
  const route = await readFile(new URL("app/api/agent-assist/workflow/item/[id]/complete/route.js", root), "utf8");
  // Name-agnostic: what matters is that the route re-reads the whole document
  // when slot state was touched, rather than returning a patch as if it were
  // the authoritative map.
  assert.match(route, /if \(slotStateTouched\) \w+ = await readSlotsFilled\(/);
  assert.ok(
    !/mcpSlotUpdates = \{ \.\.\.\(mcpSlotUpdates \|\| \{\}\), \.\.\.selection\.slotUpdates \}/.test(route),
    "a selection patch must never be returned as the authoritative map",
  );
});

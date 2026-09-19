import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

// The orchestrator's behaviour (claiming, chaining, retrying, ambiguity) is
// covered directly in slot-mcp-orchestrator.test.mjs with a mocked tool. These
// assertions only guard the adapter seams that cannot be reached from a unit
// test, because they depend on @/ imports or on raw SQL semantics.

test("adapter unwraps the normalized MCP wrapper, not a bare .result", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // callMcpTool returns {raw, content, text, structuredContent, isError} - the
  // tool payload is NOT on `.result`. Reading `.result` off that wrapper
  // silently yields nothing, so every output mapping would come back empty.
  assert.match(source, /getMcpResponseVariablePayload/);
  assert.ok(!/"result" in response/.test(source), "must not treat the wrapper as a {result} envelope");
  assert.match(source, /response\?\.isError/, "an isError response must fail, not map as success");
});

test("session writes merge instead of replacing a stale snapshot", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // slots_filled is read before a slow tool call; a concurrent agent edit must
  // survive the write that lands after it.
  assert.match(source, /slots_filled = \(COALESCE\(slots_filled, '\{\}'::jsonb\) \|\| \$1::jsonb\)/);
  assert.ok(!/SET slots_filled = \$1::jsonb,/.test(source), "must not overwrite the whole document");
});

test("the claim is a conditional write on a per-binding fingerprint map", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // mcp_runs maps binding key -> latest fingerprint. An everlasting set of all
  // fingerprints ever seen would treat A -> B -> A as already done.
  assert.match(source, /jsonb_build_object\(\$2::text, \$3::text\)/);
  assert.match(source, /IS DISTINCT FROM \$3/);
  // The previous value is returned so a failure restores it rather than
  // reverting to "never run", which could re-fire a side-effecting tool.
  assert.match(source, /RETURNING prev\.previous/);
});

test("derived slots complete their workflow items, not just slots_filled", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // Writing slots_filled alone leaves the checklist showing an unticked item
  // beside a value the agent can already see.
  assert.match(source, /UPDATE aa_workflow_item_status/);
  assert.match(source, /completed_by = 'mcp'/);

  // Percentage alone is not enough: the analyzer's own completion check runs
  // before bindings execute, so a workflow finished by a derived item would sit
  // at 100% and still be in_progress on the previous stage.
  assert.match(source, /recalculateCurrentStage/);
  assert.match(source, /status = 'completed', completed_at = NOW\(\)/);
});

test("results are applied only while the binding still owns its claim", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // Two corrections in flight can return out of order; the older response must
  // not overwrite the newer one's derived values.
  // The write lands only while this binding still holds the claim.
  assert.match(source, /\(COALESCE\(mcp_runs, '\{\}'::jsonb\) ->> \$7\) = \$8/);
  // Release is conditional too, so a late failure cannot clobber a newer claim.
  assert.match(source, /\(COALESCE\(mcp_runs, '\{\}'::jsonb\) ->> \$2\) = \$3/);
});

test("alternatives persist as objects the desktop can confirm", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");
  const ui = await read("components/contact-center/AgentAssistWorkflow.jsx");

  // The desktop confirms with alt.value; persisting bare label strings would
  // confirm undefined.
  assert.match(source, /value: alt\.value/);
  assert.match(source, /label: alt\.label/);
  assert.ok(!/alternatives\.map\(\(alt\) => alt\.label\)/.test(source), "must not persist bare labels");
  // The label wins over the raw value. This repo formats the fallback through
  // formatSlotDisplay, so assert the precedence rather than a literal
  // expression that legitimately differs between deployments.
  assert.match(ui, /\{alt\.label \?\? /, "the chip should show the label, not a raw facility id");
});

test("required slots are not filtered by whether they carry a binding", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // pickup_location carries a binding but is still required human input.
  // Excluding bound slots would let create_transport fire before the caller
  // ever stated a pickup. Derived slots come from binding outputs instead.
  assert.ok(
    !/i\.mcp_binding IS NULL/.test(source),
    "carrying a binding does not make a slot machine-derived",
  );
});

test("every slot-completion path runs bindings, not just transcript analysis", async () => {
  const routes = [
    "app/api/agent-assist/workflow/analyze/route.js",
    "app/api/agent-assist/workflow/slot/[name]/route.js",
    "app/api/agent-assist/workflow/item/[id]/complete/route.js",
  ];
  for (const route of routes) {
    const source = await read(route);
    assert.match(
      source,
      /runAndPersistSlotMcpBindings/,
      `${route} must run bindings so enrichment does not depend on how the slot was filled`,
    );
  }
});

test("a correction can refresh any non-agent row but not an agent override", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // The old `status <> 'completed'` guard froze the first derived value, and
  // the desktop prefers extracted_value over slotsFilled - so a refetch showed
  // the stale address again. Analyzer/prefill/inferred/MCP-selected state is
  // replaceable; only a hand-typed 'agent' override is authoritative.
  assert.match(source, /status <> 'completed' OR completed_by IS DISTINCT FROM 'agent'/);
  // Only report items the database actually updated.
  assert.match(source, /if \(rowCount > 0\)/);
});

test("the owning item of a control-slot binding is completed", async () => {
  const orchestrator = await read("lib/agent-assist/slot-mcp-orchestrator.mjs");
  const execute = await read("lib/agent-assist/slot-mcp-execute.js");

  // transport_created holds no caller value, so nothing else completes it and
  // the workflow would never reach 100% after create_transport succeeded.
  assert.match(orchestrator, /ownerItemId: binding\.trigger === "on_fill" \? null : entry\.item_id/);
  assert.match(execute, /if \(ownerItemId\) await completeItem\(ownerItemId/);
});

test("selection resolves against server-side candidates, not client data", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");
  const route = await read("app/api/agent-assist/workflow/item/[id]/complete/route.js");

  assert.match(source, /export async function resolveMcpCandidateSelection/);
  // The chosen candidate is matched against the stored list and republished as
  // a single-element array so every "0.field" output path stays valid.
  // The chosen candidate is republished preserving the tool's own result shape
  // so every "0.field" output path stays valid - returned from several
  // branches rather than assigned once.
  assert.match(source, /return \[chosen\]/);
  // Selecting one resolves the lookup, so its parked candidates are cleared -
  // through the guarded helper, which also filters agent-owned slots.
  assert.match(source, /staleCandidateKeys: \[resultKey\]/);
  // Confirming an item is how the agent picks a facility.
  assert.match(route, /resolveMcpCandidateSelection/);
});

test("submit tools default to once per session", async () => {
  const runner = await read("lib/agent-assist/slot-mcp-runner.mjs");

  assert.match(runner, /ONCE_PER_SESSION: "once_per_session"/);
  // MANUAL_SUBMIT is also a submit-type trigger (an explicit, confirmed agent
  // action), so it defaults to once-per-session alongside ON_COMPLETE.
  assert.match(
    runner,
    /resolvedTrigger === BINDING_TRIGGERS\.ON_COMPLETE \|\| resolvedTrigger === BINDING_TRIGGERS\.MANUAL_SUBMIT\s*\n?\s*\? EXECUTION_POLICIES\.ONCE_PER_SESSION/
  );
});

test("an ambiguous result is dropped from the session, not merged over", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // Merging {} is a no-op, so a previously resolved lookup would survive in
  // Postgres and satisfy an on_result binding on the very next request even
  // though the in-memory pass had discarded it.
  assert.match(source, /staleResultKeys: ambiguous \? \[resultKey\] : \[\]/);
  assert.match(source, /mcp_results = \(COALESCE\(mcp_results, '\{\}'::jsonb\) \|\| \$2::jsonb\) - \$5::text\[\]/);
});

test("one binding outcome is one atomic state change", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // Slots merged, invalidated ones removed, stale result dropped, candidates
  // parked and the version bumped in a single UPDATE inside a transaction, so
  // no other request can observe a half-applied state.
  assert.match(source, /slots_filled = \(COALESCE\(slots_filled, '\{\}'::jsonb\) \|\| \$1::jsonb\) - \$4::text\[\]/);
  assert.match(source, /await client\.query\("BEGIN"\)/);
  assert.match(source, /await client\.query\("COMMIT"\)/);
  assert.match(source, /await client\.query\("ROLLBACK"\)/);
});

test("slots and version come from one snapshot, not separate reads", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // Pairing caller-supplied slots with a separately queried version could match
  // state read at version 3 with a version of 4, letting a claim built from
  // stale arguments pass the guard that exists to stop exactly that.
  assert.match(source, /SELECT COALESCE\(slots_filled[\s\S]*?COALESCE\(slots_version, 0\)\s+AS slots_version/);
  assert.ok(
    !/slotsFilled = \{\},\n\s*mcpResults = \{\},/.test(source),
    "runAndPersistSlotMcpBindings must not take session state from its caller",
  );

  for (const route of [
    "app/api/agent-assist/workflow/analyze/route.js",
    "app/api/agent-assist/workflow/slot/[name]/route.js",
    "app/api/agent-assist/workflow/item/[id]/complete/route.js",
  ]) {
    const routeSource = await read(route);
    assert.ok(
      !/completedRuns:/.test(routeSource),
      `${route} must not supply session state independently of its version`,
    );
  }
});

test("an agent override wins in slots_filled, not just in item status", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // Refusing the item-status write while merging the slot anyway splits the
  // session: the desktop shows the agent's value from item status while binding
  // templates read the MCP value from slots_filled, so an on_complete
  // submission could carry data the agent never saw.
  assert.match(source, /st\.completed_by = 'agent'/);
  assert.match(source, /effectiveSlotUpdates/);
  assert.match(source, /JSON\.stringify\(effectiveSlotUpdates\)/);
});

test("retiring a generation happens atomically with the claim", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // Everything a retired generation owns goes in the transaction that takes the
  // claim: result, candidates, derived slots, descendant runs, AND the item
  // statuses behind those slots. Reopening items only after a successful
  // response left the session and checklist disagreeing whenever the
  // replacement call failed, returned nothing, or timed out. Only manual agent
  // completions are exempt from retirement.
  const claim = source.indexOf("async function claimInvocation(");
  const claimEnd = source.indexOf("\nasync function releaseInvocation(");
  const body = source.slice(claim, claimEnd);

  assert.match(body, /await client\.query\("BEGIN"\)/);
  assert.match(body, /mcp_results = COALESCE\(s\.mcp_results, '\{\}'::jsonb\) - \$7::text\[\]/);
  assert.match(body, /UPDATE aa_workflow_item_status st/);
  assert.match(body, /st\.completed_by IS DISTINCT FROM 'agent'/);
  assert.match(body, /await client\.query\("COMMIT"\)/);
});

test("a failed replacement does not resurrect the generation it retired", async () => {
  const execute = await read("lib/agent-assist/slot-mcp-execute.js");
  const orchestrator = await read("lib/agent-assist/slot-mcp-orchestrator.mjs");

  // Restoring the previous fingerprint would advertise a run whose result was
  // already deleted, so a caller returning to the earlier value gets skipped as
  // "already done" with nothing to show.
  assert.match(orchestrator, /delete runs\[key\];/);
  assert.ok(
    !/runs\[key\] = claimResult\.previous/.test(orchestrator),
    "a retired fingerprint must not be restored",
  );
  assert.match(execute, /SET mcp_runs = COALESCE\(mcp_runs, '\{\}'::jsonb\) - \$2/);
});

test("routes return the authoritative slot map, not a merged snapshot", async () => {
  const execute = await read("lib/agent-assist/slot-mcp-execute.js");

  // An ambiguous rerun REMOVES slots. A route merging slotUpdates into its own
  // pre-MCP snapshot keeps returning values the session no longer holds, so the
  // browser contradicts the database during exactly the correction case the
  // invalidation exists to handle.
  assert.match(execute, /SELECT COALESCE\(slots_filled, '\{\}'::jsonb\) AS slots_filled FROM aa_workflow_sessions/);
  assert.match(execute, /slotsFilled: finalSlotsFilled/);

  for (const route of [
    "app/api/agent-assist/workflow/analyze/route.js",
    "app/api/agent-assist/workflow/slot/[name]/route.js",
  ]) {
    const source = await read(route);
    assert.match(source, /if \(bindingRun\.slotsFilled\)/, `${route} must take the authoritative map`);
    assert.ok(
      !/Object\.assign\(slotsFilled, bindingRun\.slotUpdates\)/.test(source),
      `${route} must not merge into a pre-MCP snapshot`,
    );
  }
});

test("the store applies reopened items instead of dropping them", async () => {
  const store = await read("lib/stores/workflow-store.js");

  // updateItemStatus was only called for completed/suggested, so an item the
  // MCP layer reopened stayed ticked with a discarded value.
  assert.match(store, /if \(update\.status === "pending"\)/);
  // The authoritative map REPLACES rather than merges, or a removed slot would
  // be resurrected from local state. It is still fenced: a slot the agent edited
  // keeps the agent's value, so a slow response cannot revert a manual edit
  // (an earlier fix). Assert the replace-with-fence shape, not a bare assignment.
  assert.match(store, /const next = \{ \.\.\.data\.slotsFilled \};/);
  assert.match(store, /_agentSlotEdits/);
  assert.match(store, /return \{ slotsFilled: next \};/);
});

test("a narrowed lookup clears the candidates it supersedes", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // "Sutter" parks two candidates; "Sutter Palo Alto" then resolves uniquely.
  // Merging {} leaves the old candidate record for resolveMcpCandidateSelection
  // to find later.
  assert.match(source, /staleCandidateKeys: ambiguous \? \[\] : \[resultKey\]/);
  assert.match(source, /mcp_candidates = \(COALESCE\(mcp_candidates, '\{\}'::jsonb\) \|\| \$3::jsonb\) - \$9::text\[\]/);
});

test("multi-match choices reach the desktop in the same response", async () => {
  const execute = await read("lib/agent-assist/slot-mcp-execute.js");
  const store = await read("lib/stores/workflow-store.js");

  // Writing the suggestion only to the database left the agent with no chips
  // until a refetch - unable to pick a candidate and unblock the dependent
  // bindings, which is the entire point of parking them.
  // Written inside the guarded transaction and pushed onto itemUpdates, so the
  // chips arrive in the same response rather than after a refetch.
  assert.match(execute, /item_id: alternativesItemId,\s*\n\s*status: "suggested"/);
  assert.match(execute, /alternatives = \$3::jsonb/);
  // Moving an item back to suggested must clear the old value, since the
  // desktop prefers extracted_value over slotsFilled.
  assert.match(execute, /extracted_value = NULL,\s*\n\s*alternatives = \$3::jsonb/);
  assert.match(store, /alternatives: update\.alternatives \?\? \[\]/);
});

test("candidate selection finds bindings that use the default result key", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // result_key defaults to the tool name at normalize time and is never written
  // back, so matching the raw JSON field would miss those bindings entirely and
  // selection would silently do nothing.
  assert.match(source, /binding_item_id/);
  assert.match(source, /AND i\.id = \$2/);
  assert.ok(
    !/i\.mcp_binding ->> 'result_key' = \$2/.test(source),
    "must not resolve the binding by a field that may be absent",
  );
});

test("candidate selection goes through the ownership-filtered helper", async () => {
  const source = await read("lib/agent-assist/slot-mcp-execute.js");

  // A direct UPDATE would merge every mapped output over a sibling value the
  // agent had corrected by hand, while the item status kept showing theirs.
  assert.match(source, /const outcome = await persistMcpSlotUpdates\(\{[\s\S]*?staleCandidateKeys: \[resultKey\]/);
  assert.ok(
    !/SET mcp_results = COALESCE\(mcp_results, '\{\}'::jsonb\) \|\| \$2::jsonb,\n\s*mcp_candidates/.test(source),
    "selection must not write slots outside the guarded helper",
  );
});

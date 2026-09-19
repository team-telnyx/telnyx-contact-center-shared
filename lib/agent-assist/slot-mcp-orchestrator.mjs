/**
 * Orchestrates a pass of per-slot MCP tool bindings.
 *
 * All I/O is injected, so the state machine - claiming, chaining, retrying,
 * skipping - is exercised directly by unit tests rather than inferred from the
 * shape of the source. slot-mcp-execute.js supplies the real implementations.
 *
 * Pure module (no imports beyond the sibling runner) so it runs under
 * `node --test`.
 */

import {
  bindingFingerprint,
  bindingKey,
  collapseSingleAlternative,
  collectDerivedClosure,
  collectMcpProducedSlots,
  hasMeaningfulValue,
  mapBindingOutputs,
  selectTriggeredBindings,
} from "./slot-mcp-runner.mjs";

/**
 * Runaway guard, not a budget. The loop already exits as soon as nothing new is
 * triggered; this only stops a cyclic binding graph from spinning.
 */
export const MAX_INVOCATIONS_PER_PASS = 25;

/**
 * @param {Object} options
 * @param {Array}  options.bindings           collected binding entries
 * @param {Object} options.deps               {callTool, claim, release, onAlternatives, onWarning}
 * @param {Object} options.completedRuns      binding key -> latest fingerprint
 * @param {string[]} options.requiredSlots    every required slot item name
 * @param {string|null} options.manualSubmitItemId explicit manual-submit binding to run
 */
export async function orchestrateSlotMcpBindings({
  bindings = [],
  slotsFilled = {},
  mcpResults = {},
  completedRuns = {},
  requiredSlots = [],
  defaultArguments = {},
  maxInvocations = MAX_INVOCATIONS_PER_PASS,
  slotsVersion = 0,
  manualSubmitItemId = null,
  deps = {},
} = {}) {
  const { callTool, claim, release, persist, onAlternatives, onWarning } = deps;
  const result = { slotUpdates: {}, mcpResults: {}, mcpCandidates: {}, invocations: [] };
  if (!bindings.length || typeof callTool !== "function") return result;

  // Required slots the CALLER must supply: everything required, minus the
  // slots a binding produces. A slot that merely triggers a binding
  // (pickup_location) is still required human input.
  const producedSlots = collectMcpProducedSlots(bindings);
  const requiredInputSlots = requiredSlots.filter((name) => !producedSlots.has(name));

  const workingSlots = { ...slotsFilled };
  const workingResults = { ...mcpResults };
  const runs = { ...completedRuns };
  // Skipped this pass only - not persisted, so a later pass retries.
  const skipThisPass = new Set();

  // Advances as this pass's own writes land, so a chained call still claims
  // against the version its arguments were resolved from.
  let version = slotsVersion;

  let invocationCount = 0;
  while (invocationCount < maxInvocations) {
    // Vacuously true when nothing is required of the caller. Firing early is
    // still prevented by the unresolved-template check: a completion tool
    // referencing absent slots or results simply is not selected.
    const allRequiredSlotsFilled = requiredInputSlots.every((name) => hasMeaningfulValue(workingSlots[name]));

    const triggered = selectTriggeredBindings({
      bindings,
      slotsFilled: workingSlots,
      mcpResults: workingResults,
      completedRuns: runs,
      allRequiredSlotsFilled,
      defaultArguments,
      manualSubmitItemId,
    }).filter((entry) =>
      !skipThisPass.has(entry.key) &&
      (manualSubmitItemId
        ? entry.item_id === manualSubmitItemId
        // create_transport always creates a NEW transport. Even a legacy
        // on_complete binding saved by an earlier revision is manual-only now;
        // only the confirmed submit endpoint supplies manualSubmitItemId.
        : entry.binding?.tool_name !== "create_transport"),
    );

    if (triggered.length === 0) break;

    // One at a time so each result feeds the next selection round.
    const entry = triggered[0];
    const { binding, arguments: args, key, fingerprint, slot_name: slotName } = entry;
    invocationCount += 1;

    // Claim before invoking. A concurrent pass that already claimed this exact
    // work owns it; duplicating a create_transport dispatches a second
    // ambulance and nothing undoes that afterwards.
    //
    // Claiming with a DIFFERENT fingerprint means the inputs changed, so the
    // previous generation is stale from this moment - not only when the
    // replacement turns out ambiguous. A rerun that matches nothing, or fails
    // outright, must not leave the old facility behind for a submit tool to
    // send. The whole derived closure goes, chained bindings included.
    const replacing = runs[key] !== undefined && runs[key] !== fingerprint;
    const closure = replacing ? collectDerivedClosure(bindings, entry) : { slots: [], resultKeys: [], bindingKeys: [] };
    // Carried into persistence so the items behind those cleared slots are
    // reopened. The claim removes the values; without this the checklist keeps
    // showing them as completed with their old extracted_value.
    const claimedInvalidations = closure.slots;

    const claimResult =
      typeof claim === "function"
        ? await claim(key, fingerprint, version, closure)
        : { claimed: true, previous: null };
    if (!claimResult?.claimed) {
      skipThisPass.add(key);
      continue;
    }
    runs[key] = fingerprint;
    // Every real claim advances the session version. Keep this pass on the
    // post-claim snapshot even for a first-time binding; otherwise the very
    // next independent/chained claim is made against the pre-claim version.
    if (Number.isInteger(claimResult.slotsVersion)) version = claimResult.slotsVersion;

    if (replacing) {
      for (const slotName of closure.slots) {
        delete workingSlots[slotName];
        delete result.slotUpdates[slotName];
      }
      for (const resultKey of closure.resultKeys) delete workingResults[resultKey];
      for (const bindingKey_ of closure.bindingKeys) delete runs[bindingKey_];
      result.invalidatedSlots = [...new Set([...(result.invalidatedSlots || []), ...closure.slots])];
    }

    let payload = null;
    let error = null;
    let uncertainRemoteOutcome = false;
    let dispatchState = null;
    try {
      ({ payload, error } = await callTool({
        serverId: binding.server_id,
        toolName: binding.tool_name,
        input: args,
      }));
    } catch (err) {
      // The real MCP runner tags failures raised before client.callTool as
      // preflight: disabled/missing server, undiscovered tool, invalid schema,
      // auth setup and connect failures cannot have executed the target tool.
      // Once client.callTool is entered, a transport/protocol throw is marked
      // uncertain because the remote side may have completed a side effect
      // before its response was lost. Unknown injected errors remain uncertain
      // by default so a once-per-session action is never blindly duplicated.
      dispatchState = err?.mcpDispatchState || null;
      uncertainRemoteOutcome =
        err?.remoteOutcomeUncertain === true ||
        dispatchState === "uncertain" ||
        dispatchState === null;
      error = err?.message || "MCP tool call failed";
    }

    if (error) {
      // Definite remote/application failures and preflight failures are
      // retryable, including submit validation/configuration failures. An
      // uncertain post-dispatch outcome for a side-effecting once-per-session
      // tool deliberately KEEPS the claim: reconciliation is safer than issuing
      // the external action twice.
      const retryable =
        binding.execution_policy !== "once_per_session" || !uncertainRemoteOutcome;
      if (retryable && typeof release === "function") {
        await release(key);
        delete runs[key];
      }

      skipThisPass.add(key);
      result.invocations.push({
        slot_name: slotName,
        item_id: entry.item_id,
        tool_name: binding.tool_name,
        ok: false,
        error,
        retryable,
        dispatch_state: dispatchState,
        uncertain_remote_outcome: uncertainRemoteOutcome,
      });
      if (!binding.optional || !retryable) break;
      continue;
    }

    const { slotUpdates: rawMapped, alternatives } = mapBindingOutputs(binding, payload);
    const ambiguous = alternatives.length > 1;

    // When several candidates come back, EVERY derived field is ambiguous - the
    // address and location type of candidate 0 are as much a guess as its id.
    // Withhold the whole mapping and let the agent choose; filling from index 0
    // would be a guess dressed up as a mapping.
    const mapped = ambiguous ? {} : rawMapped;
    const collapsed = collapseSingleAlternative(binding, alternatives);
    const slotUpdates = { ...mapped, ...collapsed };

    // Cleared at claim time; passed on so persistence reopens their items.
    // Anything the new response refills is completed again in the same write.
    const invalidatedSlots = claimedInvalidations.filter((name) => !(name in slotUpdates));

    // Persist under both the fingerprint and the post-claim slot version. The
    // fingerprint protects against a newer invocation of this same binding;
    // the version protects the window where a source slot changes after this
    // call claimed but before the newer request has had a chance to claim.
    let applied;
    let persistError = null;
    try {
      applied =
        typeof persist === "function"
          ? await persist({
            key,
            fingerprint,
            expectedSlotsVersion: version,
            slotUpdates,
            resultKey: binding.result_key,
            payload,
            // An ambiguous lookup is NOT a resolved result. Storing it under
            // result_key would satisfy any on_result binding waiting on it, and
            // {{mcp.key.0.address}} would silently resolve to candidate 0 - so
            // validate_address would run against a facility nobody picked.
            ambiguous,
            invalidatedSlots,
            entryItemId: entry.item_id,
            alternatives: ambiguous ? alternatives : [],
            // A blank alternative target means "show choices on the owning item"
            // only. It must not also authorize MCP to replace that input slot.
            targetSlot: binding.alternatives?.target_slot || null,
            // Snapshotted so a later admin edit to this binding's outputs or
            // alternatives (path/label/value/target_slot) cannot be applied
            // retroactively to candidates that were already parked under the
            // OLD config — the CAS generation only covers tool identity and
            // arguments, not this shape (Codex review on #1371).
            bindingOutputs: binding.outputs || null,
            bindingAlternatives: binding.alternatives || null,
            // A control slot (on_result / on_complete / manual_submit owner) has
            // no caller value of its own, so nothing else will complete its item.
            ownerItemId: binding.trigger === "on_fill" ? null : entry.item_id,
            ownerSlotName: binding.trigger === "on_fill" ? null : slotName,
          })
          : true;
    } catch (err) {
      persistError = err?.message || "failed to persist tool result";
    }

    if (persistError) {
      // The remote call SUCCEEDED and the database write did not. Re-invoking a
      // lookup is harmless, so release the claim and let it retry. Re-invoking
      // a submit is not - it could book a second transport - so the claim
      // stands and the failure is surfaced for someone to reconcile.
      const retryable = binding.execution_policy !== "once_per_session";
      if (retryable && typeof release === "function") {
        await release(key);
        delete runs[key];
      }
      skipThisPass.add(key);
      result.invocations.push({
        slot_name: slotName,
        item_id: entry.item_id,
        tool_name: binding.tool_name,
        ok: false,
        persist_failed: true,
        retryable,
        error: persistError,
      });
      if (!retryable) break;
      continue;
    }

    if (applied && typeof applied === "object" && Number.isInteger(applied.slotsVersion)) {
      version = applied.slotsVersion;
    }

    if (!applied) {
      // A failed CAS means this response no longer describes the current
      // session. Release retryable lookups if we still own their claim so a
      // later pass can recompute; a once-per-session side effect deliberately
      // keeps its claim to avoid issuing the remote action twice.
      const retryable = binding.execution_policy !== "once_per_session";
      if (retryable && typeof release === "function") {
        await release(key);
        delete runs[key];
      }
      result.invocations.push({
        slot_name: slotName,
        item_id: entry.item_id,
        tool_name: binding.tool_name,
        ok: false,
        superseded: true,
        retryable,
        error: "superseded by a newer session state before the result landed",
      });
      skipThisPass.add(key);
      continue;
    }

    if (ambiguous) {
      // Held as candidates, pending the agent's choice. Dependent chains stay
      // blocked until a selection resolves this into a real result.
      result.mcpCandidates[binding.result_key] = {
        item_id: entry.item_id,
        target_slot: binding.alternatives?.target_slot || null,
        display_slot: binding.alternatives?.target_slot || slotName,
        candidates: payload,
      };
      // Drop this binding's stale outputs from the working state too, so a
      // later binding in the same pass cannot consume them.
      delete workingResults[binding.result_key];
      for (const name of invalidatedSlots) {
        delete workingSlots[name];
        delete result.slotUpdates[name];
      }
      result.invalidatedSlots = [...(result.invalidatedSlots || []), ...invalidatedSlots];
    } else {
      workingResults[binding.result_key] = payload;
      result.mcpResults[binding.result_key] = payload;
    }
    // Only what persistence actually wrote. It refuses to overwrite a slot the
    // agent corrected by hand, and merging the raw output anyway would let a
    // later binding in this same chain resolve {{slots.x}} to a value the
    // database and the agent never had.
    const persistedUpdates =
      applied && typeof applied === "object" && applied.appliedSlotUpdates ? applied.appliedSlotUpdates : slotUpdates;
    Object.assign(result.slotUpdates, persistedUpdates);
    Object.assign(workingSlots, persistedUpdates);

    if (ambiguous && typeof onAlternatives === "function") {
      // Same invariant as the persist-path targetSlot above: a blank
      // alternative target means "no explicit write target", not "fall back
      // to the owning slot". This callback isn't wired to a real consumer
      // yet, but its payload must not teach a future caller to write here.
      await onAlternatives({ entry, alternatives, targetSlot: binding.alternatives?.target_slot || null });
    }

    result.invocations.push({
      slot_name: slotName,
      item_id: entry.item_id,
      tool_name: binding.tool_name,
      result_key: binding.result_key,
      ok: true,
      slot_updates: slotUpdates,
      alternatives: ambiguous ? alternatives : [],
      // Signals the agent must disambiguate before derived fields can land.
      awaiting_selection: ambiguous,
    });
  }

  if (invocationCount >= maxInvocations && typeof onWarning === "function") {
    onWarning({ reason: "max_invocations_reached", maxInvocations });
  }

  result.completedRuns = runs;
  return result;
}

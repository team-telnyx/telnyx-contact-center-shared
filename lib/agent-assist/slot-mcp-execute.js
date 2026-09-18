/**
 * Wires the slot MCP orchestrator to the database and the MCP runtime.
 *
 * Decision logic lives in slot-mcp-runner.mjs; the pass state machine lives in
 * slot-mcp-orchestrator.mjs. Both are pure and unit-tested. This module is the
 * adapter: queries, tool invocation, and persistence.
 *
 * Tool calls run OUTSIDE the analyzer's transaction. A the reference workflow round trip is far
 * slower than the surrounding SQL and must not hold row locks open.
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import { callMcpTool } from "@/lib/mcp/mcp-tool-runner";
import { getMcpResponseVariablePayload } from "@/lib/mcp/mcp-argument-builder";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";
import { recalculateCurrentStage } from "@/lib/agent-assist/ai-handoff-processor";
import { candidateGenerationId, createMcpCandidateToken, parseMcpCandidateToken } from "@/lib/agent-assist/mcp-candidate-token.mjs";
import { collectSlotMcpBindings, mapBindingOutputs, normalizeSlotMcpBinding, unwrapMcpResultEnvelope } from "@/lib/agent-assist/slot-mcp-runner.mjs";
import { orchestrateSlotMcpBindings } from "@/lib/agent-assist/slot-mcp-orchestrator.mjs";

export const DEFAULT_TOOL_ARGUMENTS = Object.freeze({
  systemId: process.env.MCP_SYSTEM_ID || "Telnyx",
});

export function unwrapToolPayload(response) {
  if (response?.isError) {
    const detail = typeof response.text === "string" && response.text.trim()
      ? response.text.trim()
      : "MCP tool reported an error";
    return { payload: null, error: detail };
  }
  return unwrapMcpResultEnvelope(getMcpResponseVariablePayload(response));
}

export async function loadBoundWorkflowItems(workflowId) {
  const pool = getPostgresPool();
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT i.id AS item_id, i.slot_name, i.mcp_binding
       FROM aa_workflow_items i
       JOIN aa_workflow_stages s ON i.stage_id = s.id
      WHERE s.workflow_id = $1 AND i.mcp_binding IS NOT NULL
      ORDER BY s.order_index, i.order_index`,
    [workflowId],
  );
  return rows;
}

export async function loadRequiredSlots(workflowId) {
  const pool = getPostgresPool();
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT i.slot_name
       FROM aa_workflow_items i
       JOIN aa_workflow_stages s ON i.stage_id = s.id
      WHERE s.workflow_id = $1
        AND i.type = 'slot'
        AND i.is_required = true
        AND i.slot_name IS NOT NULL`,
    [workflowId],
  );
  return rows.map((row) => row.slot_name).filter(Boolean);
}

async function loadSlotItemIds(workflowId) {
  const pool = getPostgresPool();
  if (!pool) return new Map();
  const { rows } = await pool.query(
    `SELECT i.id, i.slot_name
       FROM aa_workflow_items i
       JOIN aa_workflow_stages s ON i.stage_id = s.id
      WHERE s.workflow_id = $1 AND i.slot_name IS NOT NULL`,
    [workflowId],
  );
  return new Map(rows.map((row) => [row.slot_name, row.id]));
}

async function claimInvocation(sessionId, key, fingerprint, slotsVersion, closure = null) {
  const pool = getPostgresPool();
  if (!pool) return { claimed: false, previous: null, itemUpdates: [] };

  const staleSlots = closure?.slots || [];
  const staleResults = closure?.resultKeys || [];
  const staleRuns = closure?.bindingKeys || [];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `WITH prev AS (
         SELECT COALESCE(mcp_runs, '{}'::jsonb) ->> $2 AS previous
           FROM aa_workflow_sessions WHERE id = $1
       )
       UPDATE aa_workflow_sessions s
          SET mcp_runs = (COALESCE(s.mcp_runs, '{}'::jsonb) - $5::text[])
                         || jsonb_build_object($2::text, $3::text),
              slots_filled = COALESCE(s.slots_filled, '{}'::jsonb) - (
                SELECT COALESCE(array_agg(candidate), ARRAY[]::text[])
                  FROM unnest($6::text[]) AS candidate
                 WHERE NOT EXISTS (
                   SELECT 1
                     FROM aa_workflow_item_status st
                     JOIN aa_workflow_items wi ON wi.id = st.item_id
                    WHERE st.session_id = s.id
                      AND st.status = 'completed'
                      AND st.completed_by = 'agent'
                      AND wi.slot_name = candidate
                 )
              ),
              mcp_results = COALESCE(s.mcp_results, '{}'::jsonb) - $7::text[],
              mcp_candidates = COALESCE(s.mcp_candidates, '{}'::jsonb) - $7::text[],
              slots_version = COALESCE(s.slots_version, 0) + 1,
              updated_at = NOW()
         FROM prev
        WHERE s.id = $1
          AND (COALESCE(s.mcp_runs, '{}'::jsonb) ->> $2) IS DISTINCT FROM $3
          AND COALESCE(s.slots_version, 0) = $4
       RETURNING prev.previous AS previous,
                 s.slots_version AS slots_version,
                 COALESCE(s.slots_filled, '{}'::jsonb) AS slots_filled`,
      [sessionId, key, fingerprint, slotsVersion, staleRuns, staleSlots, staleResults],
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return { claimed: false, previous: null, itemUpdates: [] };
    }

    const itemUpdates = [];
    if (staleSlots.length > 0) {
      const { rows: reopened } = await client.query(
        `UPDATE aa_workflow_item_status st
            SET status = 'pending',
                completed_at = NULL,
                completed_by = NULL,
                extracted_value = NULL,
                confidence_score = NULL,
                alternatives = NULL,
                source_transcript = NULL,
                is_correction = FALSE,
                is_manual_edit = FALSE,
                updated_at = NOW()
           FROM aa_workflow_items wi
          WHERE wi.id = st.item_id
            AND st.session_id = $1
            AND wi.slot_name = ANY($2::text[])
            AND st.completed_by IS DISTINCT FROM 'agent'
        RETURNING st.item_id, wi.slot_name`,
        [sessionId, staleSlots],
      );
      for (const row of reopened) {
        itemUpdates.push({
          item_id: row.item_id,
          status: "pending",
          slot_name: row.slot_name,
          extracted_value: null,
          completed_by: null,
          alternatives: [],
        });
      }
    }

    await client.query("COMMIT");
    return {
      claimed: true,
      previous: rows[0].previous ?? null,
      slotsVersion: rows[0].slots_version,
      slotsFilled: rows[0].slots_filled || {},
      itemUpdates,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function releaseInvocation(sessionId, key, fingerprint) {
  const pool = getPostgresPool();
  if (!pool || !fingerprint) return;

  await pool.query(
    `UPDATE aa_workflow_sessions
        SET mcp_runs = COALESCE(mcp_runs, '{}'::jsonb) - $2,
            updated_at = NOW()
      WHERE id = $1 AND (COALESCE(mcp_runs, '{}'::jsonb) ->> $2) = $3`,
    [sessionId, key, fingerprint],
  );
}

export async function persistMcpSlotUpdates({
  sessionId,
  workflowId,
  slotUpdates = {},
  mcpResults = {},
  mcpCandidates = {},
  staleResultKeys = [],
  staleCandidateKeys = [],
  invalidatedSlots = [],
  key = null,
  fingerprint = null,
  expectedSlotsVersion = null,
  slotItemIds = null,
  ownerItemId = null,
  ownerSlotName = null,
  alternatives = [],
  alternativesItemId = null,
  alternativesResultKey = null,
  alternativesGeneration = null,
  provenance = "mcp",
  expectGeneration = null,
  generationResultKey = null,
}) {
  const pool = getPostgresPool();
  if (!pool || !sessionId) return { applied: false, itemUpdates: [], slotsVersion: null };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ownershipRelevantSlots = [...new Set([...Object.keys(slotUpdates), ...invalidatedSlots])];
    const agentOwnedSet = new Set();
    if (ownershipRelevantSlots.length > 0) {
      const { rows: agentOwned } = await client.query(
        `SELECT i.slot_name
           FROM aa_workflow_item_status st
           JOIN aa_workflow_items i ON i.id = st.item_id
          WHERE st.session_id = $1
            AND st.status = 'completed'
            AND st.completed_by = 'agent'
            AND i.slot_name = ANY($2::text[])`,
        [sessionId, ownershipRelevantSlots],
      );
      for (const row of agentOwned) agentOwnedSet.add(row.slot_name);
    }

    const effectiveSlotUpdates = Object.fromEntries(
      Object.entries(slotUpdates).filter(([slotName]) => !agentOwnedSet.has(slotName)),
    );
    const effectiveInvalidatedSlots = invalidatedSlots.filter((slotName) => !agentOwnedSet.has(slotName));

    const params = [
      JSON.stringify(effectiveSlotUpdates),
      JSON.stringify(mcpResults),
      JSON.stringify(mcpCandidates),
      effectiveInvalidatedSlots,
      staleResultKeys,
      sessionId,
      key && fingerprint ? key : null,
      key && fingerprint ? fingerprint : null,
      staleCandidateKeys,
      expectGeneration && generationResultKey ? generationResultKey : null,
      expectGeneration && generationResultKey ? expectGeneration : null,
      Number.isInteger(expectedSlotsVersion) ? expectedSlotsVersion : null,
    ];

    const updated = await client.query(
      `UPDATE aa_workflow_sessions
          SET slots_filled = (COALESCE(slots_filled, '{}'::jsonb) || $1::jsonb) - $4::text[],
              mcp_results = (COALESCE(mcp_results, '{}'::jsonb) || $2::jsonb) - $5::text[],
              mcp_candidates = (COALESCE(mcp_candidates, '{}'::jsonb) || $3::jsonb) - $9::text[],
              slots_version = COALESCE(slots_version, 0) + 1,
              updated_at = NOW()
        WHERE id = $6
          AND ($7::text IS NULL OR (COALESCE(mcp_runs, '{}'::jsonb) ->> $7) = $8)
          AND ($10::text IS NULL OR (mcp_candidates -> $10 ->> 'generation') IS NOT DISTINCT FROM $11)
          AND ($12::bigint IS NULL OR COALESCE(slots_version, 0) = $12::bigint)
      RETURNING slots_version`,
      params,
    );
    if (updated.rowCount === 0) {
      await client.query("ROLLBACK");
      return { applied: false, itemUpdates: [], slotsVersion: null };
    }

    const itemIds = slotItemIds || (await loadSlotItemIds(workflowId));
    const itemUpdates = [];

    for (const slotName of effectiveInvalidatedSlots) {
      const itemId = itemIds.get(slotName);
      if (!itemId) continue;
      const { rowCount } = await client.query(
        `UPDATE aa_workflow_item_status
            SET status = 'pending',
                completed_at = NULL,
                completed_by = NULL,
                extracted_value = NULL,
                confidence_score = NULL,
                alternatives = NULL,
                source_transcript = NULL,
                is_correction = FALSE,
                is_manual_edit = FALSE,
                updated_at = NOW()
          WHERE session_id = $1
            AND item_id = $2
            AND completed_by IS DISTINCT FROM 'agent'`,
        [sessionId, itemId],
      );
      if (rowCount > 0) {
        itemUpdates.push({
          item_id: itemId,
          status: "pending",
          slot_name: slotName,
          extracted_value: null,
          completed_by: null,
          alternatives: [],
        });
      }
    }

    const completeItem = async (itemId, value, slotName) => {
      if (!itemId) return;
      const extracted = value === undefined ? null : typeof value === "object" ? JSON.stringify(value) : String(value);
      const { rowCount } = await client.query(
        `UPDATE aa_workflow_item_status
            SET status = 'completed',
                completed_at = NOW(),
                completed_by = $4,
                extracted_value = COALESCE($3, extracted_value),
                alternatives = NULL,
                updated_at = NOW()
          WHERE session_id = $1
            AND item_id = $2
            AND (status <> 'completed' OR completed_by IS DISTINCT FROM 'agent')`,
        [sessionId, itemId, extracted, provenance],
      );
      if (rowCount > 0) {
        itemUpdates.push({
          item_id: itemId,
          status: "completed",
          completed_by: provenance,
          extracted_value: value,
          slot_name: slotName,
          confidence: 1,
          alternatives: [],
        });
      }
    };

    for (const [slotName, value] of Object.entries(effectiveSlotUpdates)) {
      await completeItem(itemIds.get(slotName), value, slotName);
    }
    if (ownerItemId) await completeItem(ownerItemId, undefined, ownerSlotName);

    if (alternatives.length > 0 && alternativesItemId) {
      const shaped = alternatives.map((alt, index) => ({
        // The button submits an opaque identity token, never the candidate's
        // business value. This is what makes duplicate/object values safe.
        value: createMcpCandidateToken({
          resultKey: alternativesResultKey,
          generation: alternativesGeneration,
          candidateIndex: index,
        }),
        label: alt.label,
        candidate_value: alt.value,
        confidence: 1,
        candidate_index: index,
        result_key: alternativesResultKey,
        generation_id: candidateGenerationId(alternativesGeneration),
      }));
      const { rowCount } = await client.query(
        `UPDATE aa_workflow_item_status
            SET status = 'suggested',
                completed_at = NULL,
                completed_by = 'mcp',
                extracted_value = NULL,
                alternatives = $3::jsonb,
                updated_at = NOW()
          WHERE session_id = $1
            AND item_id = $2
            AND (status IS DISTINCT FROM 'completed' OR completed_by IS DISTINCT FROM 'agent')`,
        [sessionId, alternativesItemId, JSON.stringify(shaped)],
      );
      if (rowCount > 0) {
        itemUpdates.push({
          item_id: alternativesItemId,
          status: "suggested",
          completed_by: "mcp",
          extracted_value: null,
          alternatives: shaped,
        });
      }
    }

    await client.query("COMMIT");
    return {
      applied: true,
      itemUpdates,
      slotsVersion: updated.rows[0].slots_version,
      appliedSlotUpdates: effectiveSlotUpdates,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function recalculateSessionState(sessionId) {
  const pool = getPostgresPool();
  if (!pool) return null;

  await recalculateCurrentStage(sessionId);

  const { rows: [session] } = await pool.query(
    `SELECT completion_percentage, status FROM aa_workflow_sessions WHERE id = $1`,
    [sessionId],
  );
  const completionPercentage = Number(session?.completion_percentage || 0);

  if (completionPercentage === 100 && session?.status === "in_progress") {
    await pool.query(
      `UPDATE aa_workflow_sessions
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'in_progress'`,
      [sessionId],
    );
  } else if (completionPercentage < 100 && session?.status === "completed") {
    await pool.query(
      `UPDATE aa_workflow_sessions
          SET status = 'in_progress', completed_at = NULL, updated_at = NOW()
        WHERE id = $1 AND status = 'completed'`,
      [sessionId],
    );
  }
  return completionPercentage;
}

export async function readSlotsFilled(sessionId) {
  const pool = getPostgresPool();
  if (!pool || !sessionId) return null;
  const { rows: [row] } = await pool.query(
    `SELECT COALESCE(slots_filled, '{}'::jsonb) AS slots_filled FROM aa_workflow_sessions WHERE id = $1`,
    [sessionId],
  );
  return row?.slots_filled ?? null;
}

function normalizePathSegments(path) {
  return String(path ?? "")
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
}

function selectedPayloadForBinding(record, binding, chosen) {
  const path = binding?.alternatives?.path;
  if (!path || path === "$" || path === ".") return [chosen];

  const source = record?.payload;
  if (!source || typeof source !== "object") return [chosen];

  const clone = structuredClone(source);
  const parts = normalizePathSegments(path);
  if (parts.length === 0) return [chosen];

  let cursor = clone;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!cursor || typeof cursor !== "object" || !(part in cursor)) return [chosen];
    cursor = cursor[part];
  }
  if (!cursor || typeof cursor !== "object") return [chosen];
  cursor[parts[parts.length - 1]] = [chosen];
  return clone;
}

export async function resolveMcpCandidateSelection({ sessionId, workflowId, itemId, value }) {
  const none = { resolved: false, pending: false, slotUpdates: {}, itemUpdates: [] };
  const rejected = { resolved: false, pending: true, slotUpdates: {}, itemUpdates: [] };
  const token = parseMcpCandidateToken(value);
  // No token means this is a genuine manual edit/confirmation. Candidate
  // parking must never make an arbitrary agent-entered value invalid.
  if (!token) return none;

  const pool = getPostgresPool();
  if (!pool || !sessionId || !itemId) return rejected;

  const { rows: [session] } = await pool.query(
    `SELECT mcp_candidates FROM aa_workflow_sessions WHERE id = $1`,
    [sessionId],
  );
  const parked = session?.mcp_candidates;
  if (!parked || typeof parked !== "object") return rejected;

  const record = parked[token.resultKey];
  if (
    !record ||
    record.item_id !== itemId ||
    candidateGenerationId(record.generation) !== token.generationId
  ) {
    return rejected;
  }
  const resultKey = token.resultKey;
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  const index = token.candidateIndex;
  if (index < 0 || index >= candidates.length) return rejected;

  // Use the binding shape snapshotted when these candidates were parked, not
  // whatever the item's mcp_binding has been edited to since. The CAS
  // generation only fingerprints tool identity + arguments, so an admin
  // changing only outputs/alternatives (path/label/value/target_slot) would
  // otherwise pass CAS and remap an old payload through the new config
  // (Codex review on #1371). Records parked before this snapshot existed
  // fall back to the live definition, same as before.
  let binding;
  if (record.binding_outputs || record.binding_alternatives) {
    binding = { outputs: record.binding_outputs || {}, alternatives: record.binding_alternatives || null };
  } else {
    const { rows: [row] } = await pool.query(
      `SELECT i.mcp_binding
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON i.stage_id = s.id
        WHERE s.workflow_id = $1 AND i.mcp_binding IS NOT NULL AND i.id = $2
        LIMIT 1`,
      [workflowId, record.binding_item_id || itemId],
    );
    binding = normalizeSlotMcpBinding(row?.mcp_binding);
    if (!binding) return rejected;
  }

  const chosen = candidates[index];
  const resolvedPayload = selectedPayloadForBinding(record, binding, chosen);
  const { slotUpdates: mappedUpdates, alternatives } = mapBindingOutputs(binding, resolvedPayload);
  // A parked record may carry an explicit write target. A blank configured
  // target means the owning item was only the DISPLAY location for the choices;
  // selecting one must not replace caller/LLM input such as pickup_location.
  const targetSlot = record.target_slot || binding?.alternatives?.target_slot || null;
  const selectedValue =
    Array.isArray(record.candidate_values) && record.candidate_values.length === candidates.length
      ? record.candidate_values[index]
      : alternatives[0]?.value ?? chosen;
  const slotUpdates = targetSlot
    ? { ...mappedUpdates, [targetSlot]: selectedValue }
    : mappedUpdates;

  const outcome = await persistMcpSlotUpdates({
    sessionId,
    workflowId,
    slotUpdates,
    mcpResults: { [resultKey]: resolvedPayload },
    staleCandidateKeys: [resultKey],
    expectGeneration: record.generation ?? null,
    generationResultKey: resultKey,
    provenance: "mcp_selected",
    // With a blank write target the candidate chips were displayed on the
    // binding owner. Complete that DISPLAY row in this same transaction, while
    // leaving its existing slots_filled input untouched. With an explicit target
    // the mapped slot update already completes the displayed target item.
    ownerItemId: targetSlot ? null : itemId,
    ownerSlotName: null,
  });
  if (!outcome.applied) return rejected;

  return {
    resolved: true,
    pending: true,
    resultKey,
    generationId: token.generationId,
    selectedSlotNames: Object.keys(outcome.appliedSlotUpdates || slotUpdates),
    slotUpdates: outcome.appliedSlotUpdates || slotUpdates,
    itemUpdates: outcome.itemUpdates,
  };
}

/**
 * Manual entry is authoritative even if the item previously held MCP choices.
 * Remove any parked candidate generations for that item so stale chips cannot
 * later be replayed after the agent typed a different value.
 */
export async function clearMcpCandidatesForItem(sessionId, itemId) {
  const pool = getPostgresPool();
  if (!pool || !sessionId || !itemId) return;
  await pool.query(
    `UPDATE aa_workflow_sessions
        SET mcp_candidates = COALESCE(mcp_candidates, '{}'::jsonb) - ARRAY(
              SELECT key
                FROM jsonb_each(COALESCE(mcp_candidates, '{}'::jsonb))
               WHERE value ->> 'item_id' = $2
            ),
            updated_at = NOW()
      WHERE id = $1`,
    [sessionId, itemId],
  );
}

export async function runAndPersistSlotMcpBindings({
  sessionId,
  workflowId,
  interactionId = null,
  manualSubmitItemId = null,
} = {}) {
  const empty = {
    slotUpdates: {},
    mcpResults: {},
    mcpCandidates: {},
    invocations: [],
    itemUpdates: [],
    completionPercentage: null,
    slotsFilled: null,
  };
  if (!sessionId || !workflowId) return empty;

  const boundItems = await loadBoundWorkflowItems(workflowId);
  const bindings = collectSlotMcpBindings(boundItems);
  if (bindings.length === 0) return empty;

  const [requiredSlots, slotItemIds] = await Promise.all([
    loadRequiredSlots(workflowId),
    loadSlotItemIds(workflowId),
  ]);

  const pool = getPostgresPool();
  const { rows: [snapshot] } = await pool.query(
    `SELECT COALESCE(slots_filled, '{}'::jsonb)  AS slots_filled,
            COALESCE(mcp_results, '{}'::jsonb)   AS mcp_results,
            COALESCE(mcp_runs, '{}'::jsonb)      AS mcp_runs,
            COALESCE(slots_version, 0)           AS slots_version
       FROM aa_workflow_sessions
      WHERE id = $1`,
    [sessionId],
  );
  if (!snapshot) return empty;

  const slotsFilled = snapshot.slots_filled || {};
  const mcpResults = snapshot.mcp_results || {};
  const completedRuns = snapshot.mcp_runs && !Array.isArray(snapshot.mcp_runs) ? snapshot.mcp_runs : {};

  const logContext = { sessionId, interactionId, workflowId };
  const itemUpdates = [];
  const claims = new Map();

  const result = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled,
    mcpResults,
    completedRuns,
    requiredSlots,
    defaultArguments: DEFAULT_TOOL_ARGUMENTS,
    slotsVersion: Number(snapshot.slots_version ?? 0),
    manualSubmitItemId,
    deps: {
      callTool: async ({ serverId, toolName, input }) =>
        unwrapToolPayload(await callMcpTool({ serverId, toolName, input })),
      claim: async (key, fingerprint, version, closure) => {
        const claim = await claimInvocation(sessionId, key, fingerprint, version, closure);
        if (claim.claimed) {
          // claimInvocation preserves genuinely agent-owned values in
          // slots_filled. Narrow the shared closure array in place to the slots
          // the claim actually removed so the orchestrator keeps protected
          // values in its working snapshot for downstream bindings this pass.
          if (Array.isArray(closure?.slots)) {
            const removedSlots = closure.slots.filter(
              (slotName) => !Object.prototype.hasOwnProperty.call(claim.slotsFilled || {}, slotName),
            );
            closure.slots.splice(0, closure.slots.length, ...removedSlots);
          }
          claims.set(key, fingerprint);
          if (claim.itemUpdates?.length) itemUpdates.push(...claim.itemUpdates);
        }
        return claim;
      },
      release: (key) => releaseInvocation(sessionId, key, claims.get(key) ?? null),
      persist: async ({ key, fingerprint, expectedSlotsVersion, slotUpdates, resultKey, payload, ownerItemId, ownerSlotName, ambiguous, targetSlot, entryItemId, invalidatedSlots, alternatives, bindingOutputs, bindingAlternatives }) => {
        const outcome = await persistMcpSlotUpdates({
          sessionId,
          workflowId,
          slotUpdates,
          mcpResults: ambiguous ? {} : { [resultKey]: payload },
          staleResultKeys: ambiguous ? [resultKey] : [],
          staleCandidateKeys: ambiguous ? [] : [resultKey],
          mcpCandidates: ambiguous
            ? {
                [resultKey]: {
                  // With no explicit target, chips are rendered on the binding
                  // owner but selecting one writes only declared outputs.
                  item_id: slotItemIds.get(targetSlot) || entryItemId || null,
                  binding_item_id: entryItemId || null,
                  target_slot: targetSlot,
                  generation: fingerprint,
                  candidates: alternatives.map((alt) => alt.raw),
                  candidate_values: alternatives.map((alt) => alt.value),
                  payload,
                  // Selection must map through the binding shape that produced
                  // these candidates, not whatever the item's mcp_binding has
                  // been edited to since (Codex review on #1371).
                  binding_outputs: bindingOutputs || null,
                  binding_alternatives: bindingAlternatives || null,
                },
              }
            : {},
          key,
          fingerprint,
          expectedSlotsVersion,
          slotItemIds,
          ownerItemId,
          ownerSlotName,
          invalidatedSlots,
          alternatives: ambiguous ? alternatives : [],
          alternativesItemId: ambiguous ? slotItemIds.get(targetSlot) || entryItemId || null : null,
          alternativesResultKey: resultKey,
          alternativesGeneration: fingerprint,
        });
        if (outcome.applied) itemUpdates.push(...outcome.itemUpdates);
        return outcome.applied
          ? { slotsVersion: outcome.slotsVersion, appliedSlotUpdates: outcome.appliedSlotUpdates }
          : false;
      },
      onWarning: ({ reason, maxInvocations }) =>
        workflowLogger.error("slot_mcp_bindings_capped", agentAssistRuntimePayload({ ...logContext, reason, status: String(maxInvocations) })),
    },
  });

  for (const invocation of result.invocations) {
    if (invocation.ok) {
      workflowLogger.info("slot_mcp_binding_completed", agentAssistRuntimePayload({
        ...logContext, slotName: invocation.slot_name, toolName: invocation.tool_name, status: "ok",
      }));
    } else {
      workflowLogger.error("slot_mcp_binding_failed", agentAssistRuntimePayload({
        ...logContext, slotName: invocation.slot_name, toolName: invocation.tool_name, reason: invocation.error,
      }));
    }
  }

  let completionPercentage = null;
  let finalSlotsFilled = null;
  if (itemUpdates.length > 0 || result.invocations.length > 0) {
    completionPercentage = await recalculateSessionState(sessionId);
    const { rows: [row] } = await pool.query(
      `SELECT COALESCE(slots_filled, '{}'::jsonb) AS slots_filled FROM aa_workflow_sessions WHERE id = $1`,
      [sessionId],
    );
    finalSlotsFilled = row?.slots_filled || {};
  }

  return { ...result, itemUpdates, completionPercentage, slotsFilled: finalSlotsFilled };
}

#!/usr/bin/env node
/**
 * Upsert the reference workflow Healthcare Intake workflow stages/items into the database.
 *
 * Usage:
 *   node scripts/upsert-medical-transport-intake-workflow.mjs
 *   WORKFLOW_ID=c0110204-fb91-4ecf-a0d8-b42eb067bda0 node scripts/upsert-medical-transport-intake-workflow.mjs
 *   node scripts/upsert-medical-transport-intake-workflow.mjs --force   # bypass the active-session check below
 *
 * Run against cc.example.com DB from a host with DATABASE_URL / postgres env configured,
 * or locally then deploy. Refuses to run (aborts, no changes made) if the workflow has an
 * active in_progress session — replacing stages cascades to items/item statuses, which
 * would corrupt that call's checklist mid-conversation. Wait for it to finish, or pass
 * --force (or FORCE=true) to proceed anyway.
 */

import { getPostgresPool } from "../lib/postgres.mjs";
import { MEDICAL_TRANSPORT_INTAKE_WORKFLOW } from "../lib/medical-transport-intake-workflow.mjs";
import { fileURLToPath } from "node:url";

const DEFAULT_WORKFLOW_ID = "c0110204-fb91-4ecf-a0d8-b42eb067bda0";

// A workflow row created while this seed's own default was still the bare
// (invalid, provider-unprefixed) "gpt-4o-mini" — before it was corrected to
// "openai/gpt-4o-mini" — is stuck passing that invalid id to Telnyx forever,
// since the update branch below deliberately never re-applies llm_model to
// an existing row. Narrowly auto-correct ONLY these exact known-legacy
// values on every run; anything else (including a deliberate admin
// model-dropdown override) is left untouched.
const LEGACY_LLM_MODEL_MIGRATIONS = {
  "gpt-4o-mini": "openai/gpt-4o-mini",
};

async function insertItem(client, stageId, itemData) {
  const hints = itemData.prompt_hint
    ? itemData.prompt_hint.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  await client.query(
    `INSERT INTO aa_workflow_items
       (stage_id, type, label, description, prompt_hint, hints, order_index, is_required,
        slot_name, slot_type, slot_options, slot_validation, completion_trigger)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)`,
    [
      stageId,
      itemData.type,
      itemData.label,
      itemData.description || null,
      itemData.prompt_hint || null,
      JSON.stringify(hints),
      itemData.order_index,
      itemData.is_required !== false,
      itemData.slot_name || null,
      itemData.slot_type || null,
      itemData.slot_options ? JSON.stringify(itemData.slot_options) : null,
      itemData.slot_validation || null,
      itemData.completion_trigger ||
        (itemData.type === "slot" ? "customer" : "agent"),
    ],
  );
}

export async function upsertMedicalTransportIntakeWorkflow({
  workflowId = process.env.WORKFLOW_ID || DEFAULT_WORKFLOW_ID,
  workflowName = MEDICAL_TRANSPORT_INTAKE_WORKFLOW.name,
  force = process.env.FORCE === "true" || process.argv.includes("--force"),
} = {}) {
  const pool = getPostgresPool();
  if (!pool) {
    throw new Error("PostgreSQL pool not available — set DATABASE_URL / postgres env");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let { rows: [workflow] } = await client.query(
      `SELECT id, name, llm_model FROM aa_workflows WHERE id = $1`,
      [workflowId],
    );

    if (!workflow) {
      ({ rows: [workflow] } = await client.query(
        `SELECT id, name, llm_model FROM aa_workflows WHERE name = $1 ORDER BY updated_at DESC LIMIT 1`,
        [workflowName],
      ));
    }

    if (!workflow) {
      const def = MEDICAL_TRANSPORT_INTAKE_WORKFLOW;
      ({ rows: [workflow] } = await client.query(
        `INSERT INTO aa_workflows (id, name, description, category, is_active, llm_model, llm_confidence_threshold)
         VALUES ($1, $2, $3, $4, true, $5, $6)
         RETURNING id, name`,
        [
          workflowId,
          def.name,
          def.description,
          def.category,
          def.llm_model,
          def.llm_confidence_threshold,
        ],
      ));
      console.log(`[Intake Workflow] Created workflow ${workflow.id}`);
    } else {
      const def = MEDICAL_TRANSPORT_INTAKE_WORKFLOW;
      // Deliberately does NOT touch llm_model / llm_confidence_threshold here.
      // Those are a per-workflow, admin-UI-editable setting (the model
      // dropdown in app/(portal)/admin/workflows/[id]/page.jsx) — someone may
      // have deliberately switched this workflow to a different model (e.g.
      // to compare latency/quality across models for slot-filling and
      // suggested-response generation). Overwriting it unconditionally on
      // every re-run would silently revert that choice back to whatever this
      // seed file happens to default to, with no warning. The seed file's
      // llm_model only seeds a BRAND NEW workflow (the INSERT branch above);
      // it is never re-applied to an existing one.
      await client.query(
        `UPDATE aa_workflows SET
           name = $2,
           description = $3,
           category = $4,
           is_active = true,
           updated_at = NOW()
         WHERE id = $1`,
        [
          workflow.id,
          def.name,
          def.description,
          def.category,
        ],
      );
      console.log(`[Intake Workflow] Updating existing workflow ${workflow.id} (${workflow.name}) — llm_model/llm_confidence_threshold left untouched`);

      // One-time migration, narrowly scoped: only correct a row still stuck
      // on the exact old bad default. Never touches any other value, so a
      // deliberate admin override is never clobbered.
      const migratedModel = LEGACY_LLM_MODEL_MIGRATIONS[workflow.llm_model];
      if (migratedModel) {
        await client.query(
          `UPDATE aa_workflows SET llm_model = $2, updated_at = NOW() WHERE id = $1`,
          [workflow.id, migratedModel],
        );
        console.log(`[Intake Workflow] Migrated legacy llm_model "${workflow.llm_model}" -> "${migratedModel}" on workflow ${workflow.id}`);
      }
    }

    const { rows: activeSessions } = await client.query(
      `SELECT id FROM aa_workflow_sessions WHERE workflow_id = $1 AND status = 'in_progress' LIMIT 1`,
      [workflow.id],
    );
    if (activeSessions.length > 0 && !force) {
      // Stages cascade to items and item statuses — replacing them out from
      // under a running call wipes its checklist/status rows and can null
      // out its current stage mid-conversation. Abort (rolls back the
      // workflow name/description update above too) instead of proceeding
      // past a warning.
      throw new Error(
        `Refusing to replace stages/items for workflow ${workflow.id}: at least one ` +
        `in_progress session exists. Wait for it to finish, or re-run with ` +
        `FORCE=true / --force to proceed anyway (this WILL corrupt that running call's checklist).`,
      );
    }
    if (activeSessions.length > 0 && force) {
      console.warn(
        "[Intake Workflow] WARNING: proceeding with --force while an in_progress session exists — its checklist/status will be corrupted.",
      );
    }

    await client.query(`DELETE FROM aa_workflow_stages WHERE workflow_id = $1`, [workflow.id]);

    for (const stageData of MEDICAL_TRANSPORT_INTAKE_WORKFLOW.stages) {
      const { rows: [stage] } = await client.query(
        `INSERT INTO aa_workflow_stages (workflow_id, name, description, order_index, is_required)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [workflow.id, stageData.name, stageData.description, stageData.order_index],
      );

      for (const itemData of stageData.items) {
        await insertItem(client, stage.id, itemData);
      }
    }

    await client.query("COMMIT");

    const { rows: counts } = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM aa_workflow_stages WHERE workflow_id = $1) AS stages,
         (SELECT COUNT(*) FROM aa_workflow_items i
            JOIN aa_workflow_stages s ON s.id = i.stage_id
          WHERE s.workflow_id = $1) AS items,
         (SELECT COUNT(*) FROM aa_workflow_items i
            JOIN aa_workflow_stages s ON s.id = i.stage_id
          WHERE s.workflow_id = $1 AND i.type = 'slot') AS slots`,
      [workflow.id],
    );

    console.log(
      `[Intake Workflow] Done — id=${workflow.id}, stages=${counts[0].stages}, items=${counts[0].items}, slots=${counts[0].slots}`,
    );
    console.log(
      `[Intake Workflow] Admin URL path: /admin/workflows/${workflow.id}`,
    );
    console.log(
      "[Intake Workflow] Next: Admin → Sync insights (if AI assistant linked), then re-save call flow Agent Assist prefill for new slot names (caller_first_name).",
    );

    return { workflowId: workflow.id, ...counts[0] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  upsertMedicalTransportIntakeWorkflow()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[Intake Workflow] Failed:", err.message);
      process.exit(1);
    });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWorkflowExportBundle,
  workflowExportFilename,
  normalizeImportedWorkflowBundle,
} from "../lib/agent-assist/workflow-bundles.mjs";

test("buildWorkflowExportBundle exports portable workflow structure without assistant settings or database IDs", () => {
  const bundle = buildWorkflowExportBundle({
    id: "workflow-db-id",
    name: "Healthcare Intake",
    description: "Collect patient transport details",
    category: "healthcare",
    is_active: true,
    created_by: "user-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ai_assistant_id: "assistant-123",
    llm_model: "openai/gpt-4o",
    llm_confidence_threshold: 0.42,
    insight_group_id: "group-123",
    insight_slots_id: "slots-123",
    insight_summary_id: "summary-123",
    insight_sentiment_id: "sentiment-123",
    stages: [
      {
        id: "stage-db-id",
        workflow_id: "workflow-db-id",
        name: "Opening",
        description: "Greet caller",
        order_index: 0,
        is_required: true,
        created_at: "2026-01-01T00:00:00Z",
        items: [
          {
            id: "item-db-id",
            stage_id: "stage-db-id",
            type: "slot",
            label: "Patient name",
            description: "Ask for the patient name",
            prompt_hint: "name, patient",
            hints: ["name", "patient"],
            order_index: 0,
            is_required: true,
            slot_name: "patient_name",
            slot_type: "text",
            slot_options: ["A", "B"],
            slot_validation: "^.+$",
            completion_trigger: "either",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ],
  }, { exportedAt: "2026-06-17T12:00:00.000Z" });

  assert.equal(bundle.type, "telnyx-contact-center-agent-assist-workflow");
  assert.equal(bundle.version, "1.0");
  assert.equal(bundle.name, "Healthcare Intake");
  assert.equal(bundle.exported_at, "2026-06-17T12:00:00.000Z");
  assert.deepEqual(bundle.stages[0].items[0].hints, ["name", "patient"]);
  assert.equal(bundle.stages[0].items[0].completion_trigger, "either");

  const serialized = JSON.stringify(bundle);
  for (const forbidden of [
    "workflow-db-id",
    "stage-db-id",
    "item-db-id",
    "assistant-123",
    "openai/gpt-4o",
    "llm_confidence_threshold",
    "insight_group_id",
    "insight_slots_id",
    "insight_summary_id",
    "insight_sentiment_id",
    "created_by",
    "created_at",
    "updated_at",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} should not be exported`);
  }
});

test("normalizeImportedWorkflowBundle accepts exported bundles and returns clean create payload", () => {
  const payload = normalizeImportedWorkflowBundle({
    type: "telnyx-contact-center-agent-assist-workflow",
    version: "1.0",
    name: "Healthcare Intake",
    description: "Collect patient transport details",
    category: "healthcare",
    is_active: true,
    exported_at: "2026-06-17T12:00:00.000Z",
    stages: [
      {
        name: "Opening",
        description: "Greet caller",
        order_index: 0,
        is_required: true,
        items: [
          {
            type: "slot",
            label: "Patient name",
            description: "Ask for name",
            prompt_hint: "name",
            hints: ["name"],
            order_index: 0,
            is_required: true,
            slot_name: "patient_name",
            slot_type: "text",
            slot_options: ["A", "B"],
            slot_validation: "^.+$",
            completion_trigger: "customer",
          },
        ],
      },
    ],
  });

  assert.equal(payload.name, "Healthcare Intake");
  assert.equal(payload.is_active, false, "imported workflow should start inactive for safety");
  assert.equal(payload.stages[0].items[0].label, "Patient name");
  assert.equal(payload.stages[0].items[0].completion_trigger, "customer");
  assert.deepEqual(payload.metadata, {
    imported_from_bundle: true,
    original_exported_at: "2026-06-17T12:00:00.000Z",
  });
});

test("normalizeImportedWorkflowBundle rejects assistant settings and malformed stage/item arrays", () => {
  assert.throws(
    () => normalizeImportedWorkflowBundle({ version: "1.0", name: "Bad", ai_assistant_id: "assistant-123", stages: [] }),
    /assistant settings/i,
  );
  assert.throws(
    () => normalizeImportedWorkflowBundle({ version: "1.0", name: "Bad", stages: [{ name: "S", items: "nope" }] }),
    /items/i,
  );
  assert.throws(
    () => normalizeImportedWorkflowBundle({ version: "9.9", name: "Bad", stages: [] }),
    /unsupported version/i,
  );
  assert.throws(
    () => normalizeImportedWorkflowBundle({ version: "1.0", name: "Bad", stages: [{ name: "S", items: [{ label: "I", completion_trigger: "bot" }] }] }),
    /completion_trigger/i,
  );
  assert.throws(
    () => normalizeImportedWorkflowBundle({ version: "1.0", name: "Bad", stages: [{ name: "S", items: ["nope"] }] }),
    /each item must be an object/i,
  );
  assert.throws(
    () => normalizeImportedWorkflowBundle({ version: "1.0", name: "Bad", stages: [{ name: "S", items: [{ label: "I", type: "bot" }] }] }),
    /item type/i,
  );
});

test("workflowExportFilename builds a safe workflow bundle filename", () => {
  assert.equal(workflowExportFilename("Healthcare Intake!"), "healthcare_intake_workflow.json");
  assert.equal(workflowExportFilename(""), "agent_assist_workflow.json");
});

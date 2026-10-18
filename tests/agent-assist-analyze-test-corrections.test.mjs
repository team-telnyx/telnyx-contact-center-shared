import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

import {
  planTestWorkflowAnalysis,
  applyTestWorkflowAnalysis,
} from "../lib/agent-assist/test-workflow-analysis.mjs";
import { buildWorkflowAnalysisSystemPrompt } from "../lib/agent-assist/workflow-prompts.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

// The Test AI Agent route (analyze-test) used to drop every completed slot
// from the analyzer input, so a caller's later correction was never seen. In
// the 2026-10-17 validation (run 2) the caller said "Austin", then "my
// mistake ... I'm in Lyon, postal code 69001", and city_postcode kept
// "Austin". These tests drive the route's decision logic with that exchange
// and check it now behaves like the live route (an earlier fix).

const THRESHOLD = 0.9;

// Workflow rows as the route SELECTs them (aa_workflow_items + stage columns).
const slot = (id, slot_name, label, stage_order, extra = {}) => ({
  id,
  type: "slot",
  label,
  slot_name,
  slot_type: "text",
  completion_trigger: "customer",
  stage_name: `Stage ${stage_order}`,
  stage_order,
  ...extra,
});

const ITEMS = [
  { id: "greet", type: "action", label: "Greet the caller", completion_trigger: "agent", stage_name: "Greeting", stage_order: 0 },
  slot("energy", "energy_type", "Energy type", 1),
  slot("supplier", "current_supplier", "Current supplier", 1),
  slot("city", "city_postcode", "City or postal code", 1),
  slot("name", "first_name", "First name", 1),
  slot("notes", "additional_notes", "Additional notes", 1),
  {
    id: "confirm",
    type: "action",
    label: "Confirm all information is correct",
    completion_trigger: "customer",
    stage_name: "Closing",
    stage_order: 2,
  },
];

const completed = (value) => ({ status: "completed", extracted_value: value, value, confidence_score: 0.97 });

// State when the correction arrived (run-2-analysis-log.json, entry 37).
const RUN2_STATUSES = {
  greet: { status: "completed" },
  energy: completed("Both"),
  supplier: completed("EDF"),
  city: completed("Austin"),
};
const RUN2_SLOTS = { energy_type: "Both", current_supplier: "EDF", city_postcode: "Austin" };
const RUN2_CORRECTION =
  "Oh, I see — my mistake. I'm actually calling about my property in France. I'm in Lyon, postal code 69001.";
const RUN2_CONTEXT = [
  { speaker: "customer", text: "Austin" },
  {
    speaker: "agent",
    text: "I appreciate you sharing that, but I need to let you know — ComparEnergie specializes in energy offers for **France**. Austin appears to be outside our service area.",
  },
];

const ids = (list) => list.map((i) => i.item_id);

test("run 2: the caller's correction re-exposes completed slots with their current values", () => {
  const plan = planTestWorkflowAnalysis({
    items: ITEMS,
    itemStatuses: RUN2_STATUSES,
    slotsFilled: RUN2_SLOTS,
    transcript: RUN2_CORRECTION,
    recentContext: RUN2_CONTEXT,
  });

  assert.equal(plan.isReadBackStage, false);
  assert.equal(plan.correctionInProgress, true);
  assert.equal(plan.allowCorrections, true);
  assert.deepEqual(ids(plan.correctionCandidateItems), ["energy", "supplier", "city"]);
  const city = plan.correctionCandidateItems.find((i) => i.item_id === "city");
  assert.equal(city.current_status, "completed");
  assert.equal(city.completed_value, "Austin");
  assert.ok(ids(plan.analyzerItems).includes("city"));
  // Collection focus stays on the next open slot, not the corrected one.
  assert.deepEqual(plan.currentTarget, { label: "First name", slotName: "first_name" });

  // What the analyzer is told, built from the same plan the route passes on.
  const prompt = buildWorkflowAnalysisSystemPrompt({
    pendingItems: plan.analyzerItems,
    slotsFilled: RUN2_SLOTS,
    isReadBackStage: plan.isReadBackStage,
    allowCorrections: plan.allowCorrections,
    correctionInProgress: plan.correctionInProgress,
  });
  assert.match(prompt, /## Correction Handling/);
  assert.match(prompt, /Currently collected value: "Austin" \(ALREADY CONFIRMED/);
  assert.match(prompt, /A correction is already in progress/);
});

test("run 2: the corrected value comes back suggested with is_correction, and Austin stays the record", () => {
  const plan = planTestWorkflowAnalysis({
    items: ITEMS,
    itemStatuses: RUN2_STATUSES,
    slotsFilled: RUN2_SLOTS,
    transcript: RUN2_CORRECTION,
    recentContext: RUN2_CONTEXT,
  });
  const { updates, slotsFilled } = applyTestWorkflowAnalysis({
    plan,
    // A clear correction can score at the very top; it must still wait.
    analysisResult: {
      completed_items: [
        { item_id: "city", confidence: 1, extracted_value: "Lyon, 69001", source_text: "I'm in Lyon, postal code 69001" },
      ],
    },
    speaker: "customer",
    slotsFilled: RUN2_SLOTS,
    itemStatuses: RUN2_STATUSES,
    confidenceThreshold: THRESHOLD,
    transcript: RUN2_CORRECTION,
  });

  assert.deepEqual(updates, [
    {
      item_id: "city",
      status: "suggested",
      confidence: 1,
      extracted_value: "Lyon, 69001",
      source_text: "I'm in Lyon, postal code 69001",
      alternatives: [],
      completed_by: "ai",
      low_confidence: true,
      confidence_threshold: THRESHOLD,
      is_correction: true,
    },
  ]);
  assert.equal(slotsFilled.city_postcode, "Austin");
});

test("a correction is only taken from the speaker that owns the slot", () => {
  const plan = planTestWorkflowAnalysis({
    items: ITEMS,
    itemStatuses: RUN2_STATUSES,
    slotsFilled: RUN2_SLOTS,
    transcript: "Let me fix that, the city should be Lyon.",
    recentContext: [],
  });
  assert.equal(plan.allowCorrections, true);
  const { updates, slotsFilled } = applyTestWorkflowAnalysis({
    plan,
    analysisResult: { completed_items: [{ item_id: "city", confidence: 0.95, extracted_value: "Lyon" }] },
    speaker: "agent",
    slotsFilled: RUN2_SLOTS,
    itemStatuses: RUN2_STATUSES,
    confidenceThreshold: THRESHOLD,
  });
  assert.deepEqual(updates, []);
  assert.equal(slotsFilled.city_postcode, "Austin");
});

test("without a correction trigger a completed slot stays out of the analyzer's view", () => {
  const plan = planTestWorkflowAnalysis({
    items: ITEMS,
    itemStatuses: RUN2_STATUSES,
    slotsFilled: RUN2_SLOTS,
    transcript: "Lyon",
    recentContext: [{ speaker: "agent", text: "Could you tell me your first name?" }],
  });
  assert.equal(plan.correctionInProgress, false);
  assert.equal(plan.allowCorrections, false);
  assert.deepEqual(plan.correctionCandidateItems, []);
  assert.ok(!ids(plan.analyzerItems).includes("city"));

  // Even if the model returned the completed slot, it is not applied.
  const { updates, slotsFilled } = applyTestWorkflowAnalysis({
    plan,
    analysisResult: { completed_items: [{ item_id: "city", confidence: 0.99, extracted_value: "Lyon" }] },
    speaker: "customer",
    slotsFilled: RUN2_SLOTS,
    itemStatuses: RUN2_STATUSES,
    confidenceThreshold: THRESHOLD,
  });
  assert.deepEqual(updates, []);
  assert.equal(slotsFilled.city_postcode, "Austin");
});

test("mid-call the trigger may sit on this line or the one before it, not further back", () => {
  const base = { items: ITEMS, itemStatuses: RUN2_STATUSES, slotsFilled: RUN2_SLOTS, transcript: "Lyon, 69001" };

  const previousLine = planTestWorkflowAnalysis({
    ...base,
    recentContext: [
      { speaker: "agent", text: "Which city are you in?" },
      { speaker: "customer", text: "Sorry, Austin is wrong." },
    ],
  });
  assert.equal(previousLine.allowCorrections, true);

  const twoLinesBack = planTestWorkflowAnalysis({
    ...base,
    recentContext: [
      { speaker: "customer", text: "Sorry, Austin is wrong." },
      { speaker: "agent", text: "Thanks. Could you tell me your first name?" },
    ],
  });
  assert.equal(twoLinesBack.correctionInProgress, false);
  assert.deepEqual(twoLinesBack.correctionCandidateItems, []);
});

test("notes slots keep accumulating and are never correction candidates", () => {
  const statuses = { ...RUN2_STATUSES, notes: completed("Prefers email") };
  const slots = { ...RUN2_SLOTS, additional_notes: "Prefers email" };
  const plan = planTestWorkflowAnalysis({
    items: ITEMS,
    itemStatuses: statuses,
    slotsFilled: slots,
    transcript: "My mistake, also please call after six.",
  });
  assert.deepEqual(ids(plan.completedNotesItems), ["notes"]);
  assert.ok(!ids(plan.correctionCandidateItems).includes("notes"));

  const { updates, slotsFilled } = applyTestWorkflowAnalysis({
    plan,
    analysisResult: { completed_items: [{ item_id: "notes", confidence: 0.95, extracted_value: "Call after six" }] },
    speaker: "customer",
    slotsFilled: slots,
    itemStatuses: statuses,
    confidenceThreshold: THRESHOLD,
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "completed");
  assert.equal(updates[0].is_correction, undefined);
  assert.equal(slotsFilled.additional_notes, "Prefers email; Call after six");
});

// After the page applies the suggestion, the item is "suggested" while
// slotsFilled still says "Austin": a correction waiting for confirmation.
const PENDING_CORRECTION_STATUSES = {
  ...RUN2_STATUSES,
  city: { status: "suggested", extracted_value: "Lyon, 69001", value: "Lyon, 69001", confidence_score: 0.93 },
};

test("a pending correction is confirmed by a later clear restatement", () => {
  const plan = planTestWorkflowAnalysis({
    items: ITEMS,
    itemStatuses: PENDING_CORRECTION_STATUSES,
    slotsFilled: RUN2_SLOTS,
    transcript: "Yes, Lyon 69001.",
  });
  const city = plan.pendingItems.find((i) => i.item_id === "city");
  assert.equal(city.current_status, "suggested");
  assert.ok(ids(plan.analyzerItems).includes("city"));

  const { updates, slotsFilled } = applyTestWorkflowAnalysis({
    plan,
    analysisResult: { completed_items: [{ item_id: "city", confidence: 0.96, extracted_value: "Lyon, 69001" }] },
    speaker: "customer",
    slotsFilled: RUN2_SLOTS,
    itemStatuses: PENDING_CORRECTION_STATUSES,
    confidenceThreshold: THRESHOLD,
  });
  assert.equal(updates[0].status, "completed");
  assert.equal(updates[0].is_correction, undefined);
  assert.equal(slotsFilled.city_postcode, "Lyon, 69001");
});

// Every slot collected, a correction still waiting, confirm-all item open.
const READ_BACK_STATUSES = {
  ...PENDING_CORRECTION_STATUSES,
  name: completed("Sarah"),
  notes: completed("Prefers email"),
};
const READ_BACK_SLOTS = { ...RUN2_SLOTS, first_name: "Sarah", additional_notes: "Prefers email" };

test("at read-back every completed slot is a candidate, even without a trigger", () => {
  const plan = planTestWorkflowAnalysis({
    items: ITEMS,
    itemStatuses: READ_BACK_STATUSES,
    slotsFilled: READ_BACK_SLOTS,
    transcript: "Let me read everything back to you.",
  });
  assert.equal(plan.isReadBackStage, true);
  assert.equal(plan.correctionInProgress, false);
  assert.equal(plan.allowCorrections, true);
  assert.deepEqual(ids(plan.correctionCandidateItems), ["energy", "supplier", "name"]);
});

test("the caller's read-back affirmative completes confirm-all and promotes the pending correction", () => {
  const transcript = "Yes, that's all correct.";
  const plan = planTestWorkflowAnalysis({
    items: ITEMS,
    itemStatuses: READ_BACK_STATUSES,
    slotsFilled: READ_BACK_SLOTS,
    transcript,
  });
  // The LLM path keeps confirm-all open while a slot is unconfirmed, so the
  // model's own answer is dropped and the deterministic backstop decides.
  const { updates, slotsFilled } = applyTestWorkflowAnalysis({
    plan,
    analysisResult: { completed_items: [{ item_id: "confirm", confidence: 0.97, extracted_value: true }] },
    speaker: "customer",
    slotsFilled: READ_BACK_SLOTS,
    itemStatuses: READ_BACK_STATUSES,
    confidenceThreshold: THRESHOLD,
    transcript,
  });

  assert.deepEqual(
    updates.map((u) => [u.item_id, u.status, u.extracted_value]),
    [
      ["confirm", "completed", true],
      ["city", "completed", "Lyon, 69001"],
    ]
  );
  assert.equal(updates[0].completed_by, "customer");
  assert.equal(updates[1].confidence, 0.93);
  assert.equal(slotsFilled.city_postcode, "Lyon, 69001");
});

test("a rejection at read-back, or the agent's own recitation, promotes nothing", () => {
  const plan = planTestWorkflowAnalysis({
    items: ITEMS,
    itemStatuses: READ_BACK_STATUSES,
    slotsFilled: READ_BACK_SLOTS,
    transcript: "No, that's not correct.",
  });
  const rejected = applyTestWorkflowAnalysis({
    plan,
    analysisResult: { completed_items: [] },
    speaker: "customer",
    slotsFilled: READ_BACK_SLOTS,
    itemStatuses: READ_BACK_STATUSES,
    confidenceThreshold: THRESHOLD,
    transcript: "No, that's not correct.",
  });
  assert.deepEqual(rejected.updates, []);
  assert.equal(rejected.slotsFilled.city_postcode, "Austin");

  const agentItems = ITEMS.map((i) => (i.id === "confirm" ? { ...i, completion_trigger: "agent" } : i));
  const recitation = "So that's Lyon, Sarah, EDF — is that all correct?";
  const agentPlan = planTestWorkflowAnalysis({
    items: agentItems,
    itemStatuses: READ_BACK_STATUSES,
    slotsFilled: READ_BACK_SLOTS,
    transcript: recitation,
  });
  const recited = applyTestWorkflowAnalysis({
    plan: agentPlan,
    analysisResult: { completed_items: [] },
    speaker: "agent",
    slotsFilled: READ_BACK_SLOTS,
    itemStatuses: READ_BACK_STATUSES,
    confidenceThreshold: THRESHOLD,
    transcript: recitation,
  });
  assert.deepEqual(recited.updates, []);
  assert.equal(recited.slotsFilled.city_postcode, "Austin");
});

test("a first-time low-confidence suggestion is not treated as a correction", () => {
  const statuses = { greet: { status: "completed" } };
  const plan = planTestWorkflowAnalysis({ items: ITEMS, itemStatuses: statuses, slotsFilled: {}, transcript: "Both, I think" });
  assert.deepEqual(plan.correctionCandidateItems, []);
  const { updates, slotsFilled } = applyTestWorkflowAnalysis({
    plan,
    analysisResult: { completed_items: [{ item_id: "energy", confidence: 0.6, extracted_value: "Both" }] },
    speaker: "customer",
    slotsFilled: {},
    itemStatuses: statuses,
    confidenceThreshold: THRESHOLD,
  });
  assert.equal(updates[0].status, "suggested");
  assert.equal(updates[0].low_confidence, true);
  assert.equal(updates[0].is_correction, undefined);
  assert.equal(slotsFilled.energy_type, undefined);
});

test("analyze-test route sends the correction flags and applies results through the module", async () => {
  const route = await read("../app/api/admin/workflows/[id]/analyze-test/route.js");
  assert.match(route, /planTestWorkflowAnalysis\(\{/);
  assert.match(route, /applyTestWorkflowAnalysis\(\{/);
  assert.match(
    route,
    /analyzeWorkflowTranscript\(\{[\s\S]*?pendingItems: plan\.analyzerItems,[\s\S]*?isReadBackStage,\s*allowCorrections,\s*correctionInProgress,/
  );
  // The route no longer filters items itself; the old completed-slot
  // exclusion is gone.
  assert.doesNotMatch(route, /completedIds/);
});

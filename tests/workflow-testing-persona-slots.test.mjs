import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKFLOW_TESTING_PERSONAS,
  normalizePersona,
  personaInstruction,
  normalizeMaxSlotsPerTurn,
  resolveSlotCountForTurn,
  isUltraVoice,
  personaEmotion,
  applyUltraExpression,
  handleWorkflowTestingFinalTranscription,
} from "../lib/call-generator/workflow-testing.mjs";
import { normalizeSteps } from "../lib/call-generator/actions.mjs";

// Workflow Testing caller behaviour: persona + max answers per turn (+ random).
// These tune the LLM caller-simulation prompt so the simulated customer behaves
// in a specific way and can fill one or several slots per turn.

process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || "test-key";

test("normalizePersona accepts known ids and falls back to neutral", () => {
  assert.equal(normalizePersona("angry"), "angry");
  assert.equal(normalizePersona("IN_A_HURRY"), "in_a_hurry");
  assert.equal(normalizePersona("nonsense"), "neutral");
  assert.equal(normalizePersona(undefined), "neutral");
});

test("personaInstruction returns text for non-neutral personas and empty for neutral", () => {
  assert.equal(personaInstruction("neutral"), "");
  assert.ok(personaInstruction("angry").toLowerCase().includes("angry"));
  assert.ok(personaInstruction("in_a_hurry").toLowerCase().includes("hurry"));
});

test("every persona preset has a stable id and label", () => {
  for (const p of WORKFLOW_TESTING_PERSONAS) {
    assert.equal(typeof p.id, "string");
    assert.equal(typeof p.label, "string");
  }
});

test("normalizeMaxSlotsPerTurn clamps to 1..6 with default 1", () => {
  assert.equal(normalizeMaxSlotsPerTurn(undefined), 1);
  assert.equal(normalizeMaxSlotsPerTurn(0), 1);
  assert.equal(normalizeMaxSlotsPerTurn(3), 3);
  assert.equal(normalizeMaxSlotsPerTurn(99), 6);
  assert.equal(normalizeMaxSlotsPerTurn("4"), 4);
  assert.equal(normalizeMaxSlotsPerTurn("abc"), 1);
});

test("resolveSlotCountForTurn returns the max when not randomized", () => {
  assert.equal(resolveSlotCountForTurn({ maxSlotsPerTurn: 1, randomizeSlots: false }), 1);
  assert.equal(resolveSlotCountForTurn({ maxSlotsPerTurn: 3, randomizeSlots: false }), 3);
});

test("resolveSlotCountForTurn never exceeds the max and is >=1 when randomized", () => {
  // rng=0 -> 1, rng just below 1 -> max
  assert.equal(resolveSlotCountForTurn({ maxSlotsPerTurn: 3, randomizeSlots: true }, () => 0), 1);
  assert.equal(resolveSlotCountForTurn({ maxSlotsPerTurn: 3, randomizeSlots: true }, () => 0.999), 3);
  // sweep a range — always within [1, max]
  for (let i = 0; i < 50; i += 1) {
    const n = resolveSlotCountForTurn({ maxSlotsPerTurn: 4, randomizeSlots: true });
    assert.ok(n >= 1 && n <= 4, `slot count ${n} out of range`);
  }
});

test("randomize is ignored when max is 1 (always single slot)", () => {
  assert.equal(resolveSlotCountForTurn({ maxSlotsPerTurn: 1, randomizeSlots: true }, () => 0.999), 1);
});

test("normalizeSteps preserves persona, max_slots_per_turn and randomize on the protected step", () => {
  const [step] = normalizeSteps([
    { type: "workflow_testing", voice: "AWS.Polly.Joanna", persona: "angry", max_slots_per_turn: 3, randomize_slots: true },
  ]);
  assert.equal(step.persona, "angry");
  assert.equal(step.max_slots_per_turn, 3);
  assert.equal(step.randomize_slots, true);
});

test("normalizeSteps forces randomize off when max_slots_per_turn is 1", () => {
  const [step] = normalizeSteps([
    { type: "workflow_testing", max_slots_per_turn: 1, randomize_slots: true },
  ]);
  assert.equal(step.max_slots_per_turn, 1);
  assert.equal(step.randomize_slots, false);
});

test("normalizeSteps defaults persona to neutral on unknown value", () => {
  const [step] = normalizeSteps([{ type: "workflow_testing", persona: "bogus" }]);
  assert.equal(step.persona, "neutral");
  assert.equal(step.max_slots_per_turn, 1);
});

test("isUltraVoice detects only Telnyx.Ultra.* voices", () => {
  assert.equal(isUltraVoice("Telnyx.Ultra.Mia"), true);
  assert.equal(isUltraVoice("telnyx.ultra.mia"), true);
  assert.equal(isUltraVoice("AWS.Polly.Joanna"), false);
  assert.equal(isUltraVoice("Telnyx.Natural.x"), false);
  assert.equal(isUltraVoice(""), false);
  assert.equal(isUltraVoice(undefined), false);
});

test("personaEmotion maps personas to Ultra emotions, neutral -> null", () => {
  assert.equal(personaEmotion("neutral"), null);
  assert.equal(personaEmotion("angry"), "angry");
  assert.equal(personaEmotion("in_a_hurry"), "frustrated");
  assert.equal(personaEmotion("chatty"), "excited");
  assert.equal(personaEmotion("bogus"), null); // normalizes to neutral
});

test("applyUltraExpression prepends an emotion tag only for Ultra voices + non-neutral persona", () => {
  // Ultra + angry -> tagged
  assert.equal(
    applyUltraExpression("I want a refund now.", { voice: "Telnyx.Ultra.Mia", persona: "angry" }),
    '<emotion value="angry" />I want a refund now.'
  );
  // Non-Ultra voice -> untouched (would otherwise be spoken literally)
  assert.equal(
    applyUltraExpression("I want a refund now.", { voice: "AWS.Polly.Joanna", persona: "angry" }),
    "I want a refund now."
  );
  // Ultra + neutral -> no tag (most natural delivery)
  assert.equal(
    applyUltraExpression("Sure, John Wick.", { voice: "Telnyx.Ultra.Mia", persona: "neutral" }),
    "Sure, John Wick."
  );
});

test("applyUltraExpression does not double-tag text that already has an emotion tag", () => {
  const already = '<emotion value="excited" />Great news!';
  assert.equal(applyUltraExpression(already, { voice: "Telnyx.Ultra.Mia", persona: "angry" }), already);
});

// End-to-end: persona + slot instructions must reach the LLM caller prompt.
function makeReplyPool(ledgerRow, captureUpdates) {
  return {
    async query(sql, params) {
      if (/FROM cg_call_ledger/i.test(sql) && /status IN \('answered','talking'\)/.test(sql)) {
        return { rows: [ledgerRow] };
      }
      if (/FROM aa_workflows/i.test(sql)) {
        return { rows: [{ id: params[0], name: "Healthcare Intake", description: "Collect intake", llm_model: "openai/gpt-4o" }] };
      }
      if (/FROM aa_workflow_items/i.test(sql)) {
        return { rows: [{ label: "Patient name", description: "Full name", type: "text", slot_name: "patient_name", stage_name: "Identify", stage_order: 1, order_index: 1 }] };
      }
      if (/UPDATE cg_call_ledger/i.test(sql)) {
        captureUpdates.push(JSON.parse(params[0]));
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  };
}

test("persona and multi-slot config are injected into the LLM caller prompt", async () => {
  const captureUpdates = [];
  const ledgerRow = {
    id: "ledger-1",
    run_id: "run-1",
    call_control_id: "v3:GEN-LEG",
    result: { workflow_testing: { enabled: true, workflow_id: "wf-1", voice: "Telnyx.x", history: [], persona: "angry", max_slots_per_turn: 3, randomize_slots: false } },
  };
  const pool = makeReplyPool(ledgerRow, captureUpdates);

  let aiBody = null;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes("/ai/chat/completions")) {
      aiBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: "Yeah whatever, John Wick, Mercy General, July 4 1978." } }] }; } };
    }
    if (u.includes("/actions/speak")) return { ok: true, async json() { return {}; } };
    return { ok: false, status: 404, async text() { return "nope"; } };
  };
  try {
    const res = await handleWorkflowTestingFinalTranscription({
      pool,
      interaction: { id: "int-1", from_number: "+48221811540" },
      payload: { from: "+48221811540" },
      transcriptionData: { transcript: "Can I get your name, facility and date of birth?", is_final: true },
      assistConfig: { assist_type: "workflows", workflow_id: "wf-1" },
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    const systemMsg = aiBody.messages.find((m) => m.role === "system").content;
    // persona instruction present
    assert.ok(systemMsg.toLowerCase().includes("angry"), "system prompt should carry the angry persona");
    // multi-slot instruction present and capped at 3
    assert.ok(/UP TO 3/.test(systemMsg), "system prompt should allow up to 3 pieces");
    const userMsg = JSON.parse(aiBody.messages.find((m) => m.role === "user").content);
    assert.equal(userMsg.persona, "angry");
    assert.equal(userMsg.max_information_pieces_this_turn, 3);
  } finally {
    global.fetch = original;
  }
});

test("default neutral single-slot config yields a single-slot prompt with no persona pressure", async () => {
  const captureUpdates = [];
  const ledgerRow = {
    id: "ledger-2",
    run_id: "run-2",
    call_control_id: "v3:GEN-LEG",
    result: { workflow_testing: { enabled: true, workflow_id: "wf-1", voice: "Telnyx.x", history: [] } },
  };
  const pool = makeReplyPool(ledgerRow, captureUpdates);

  let aiBody = null;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes("/ai/chat/completions")) {
      aiBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: "John Wick." } }] }; } };
    }
    if (u.includes("/actions/speak")) return { ok: true, async json() { return {}; } };
    return { ok: false, status: 404, async text() { return "nope"; } };
  };
  try {
    const res = await handleWorkflowTestingFinalTranscription({
      pool,
      interaction: { id: "int-2", from_number: "+48221811540" },
      payload: { from: "+48221811540" },
      transcriptionData: { transcript: "What is your name?", is_final: true },
      assistConfig: { assist_type: "workflows", workflow_id: "wf-1" },
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    const systemMsg = aiBody.messages.find((m) => m.role === "system").content;
    assert.ok(/exactly ONE/.test(systemMsg), "single-slot instruction expected");
    const userMsg = JSON.parse(aiBody.messages.find((m) => m.role === "user").content);
    assert.equal(userMsg.persona, "neutral");
    assert.equal(userMsg.max_information_pieces_this_turn, 1);
  } finally {
    global.fetch = original;
  }
});

test("Ultra voice + angry persona speaks an emotion-tagged payload but stores clean history", async () => {
  const captureUpdates = [];
  const ledgerRow = {
    id: "ledger-ultra",
    run_id: "run-ultra",
    call_control_id: "v3:GEN-LEG",
    result: { workflow_testing: { enabled: true, workflow_id: "wf-1", voice: "Telnyx.Ultra.Mia", history: [], persona: "angry", max_slots_per_turn: 1, randomize_slots: false } },
  };
  const pool = makeReplyPool(ledgerRow, captureUpdates);

  let aiBody = null;
  let speakBody = null;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes("/ai/chat/completions")) {
      aiBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: "Finally, my name is John Wick." } }] }; } };
    }
    if (u.includes("/actions/speak")) { speakBody = JSON.parse(options.body); return { ok: true, async json() { return {}; } }; }
    return { ok: false, status: 404, async text() { return "nope"; } };
  };
  try {
    const res = await handleWorkflowTestingFinalTranscription({
      pool,
      interaction: { id: "int-ultra", from_number: "+48221811540" },
      payload: { from: "+48221811540" },
      transcriptionData: { transcript: "Can I get your name?", is_final: true },
      assistConfig: { assist_type: "workflows", workflow_id: "wf-1" },
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    // Expressive instruction reached the prompt (Ultra voice)
    const systemMsg = aiBody.messages.find((m) => m.role === "system").content;
    assert.ok(/SSML emotion tags/.test(systemMsg), "expressive instruction expected for Ultra voice");
    // TTS payload carries the emotion tag for the angry persona
    assert.equal(speakBody.payload, '<emotion value="angry" />Finally, my name is John Wick.');
    assert.equal(speakBody.voice, "Telnyx.Ultra.Mia");
    // History + returned reply stay clean (no SSML)
    assert.equal(res.reply, "Finally, my name is John Wick.");
    const hist = captureUpdates.at(-1).workflow_testing.history;
    assert.equal(hist.at(-1).text, "Finally, my name is John Wick.");
    assert.ok(!/emotion/.test(hist.at(-1).text), "history must not contain SSML tags");
  } finally {
    global.fetch = original;
  }
});

test("non-Ultra voice never injects emotion tags into the spoken payload", async () => {
  const captureUpdates = [];
  const ledgerRow = {
    id: "ledger-natural",
    run_id: "run-natural",
    call_control_id: "v3:GEN-LEG",
    result: { workflow_testing: { enabled: true, workflow_id: "wf-1", voice: "AWS.Polly.Joanna", history: [], persona: "angry", max_slots_per_turn: 1, randomize_slots: false } },
  };
  const pool = makeReplyPool(ledgerRow, captureUpdates);

  let aiBody = null;
  let speakBody = null;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes("/ai/chat/completions")) {
      aiBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: "Ugh, John Wick." } }] }; } };
    }
    if (u.includes("/actions/speak")) { speakBody = JSON.parse(options.body); return { ok: true, async json() { return {}; } }; }
    return { ok: false, status: 404, async text() { return "nope"; } };
  };
  try {
    const res = await handleWorkflowTestingFinalTranscription({
      pool,
      interaction: { id: "int-natural", from_number: "+48221811540" },
      payload: { from: "+48221811540" },
      transcriptionData: { transcript: "Your name?", is_final: true },
      assistConfig: { assist_type: "workflows", workflow_id: "wf-1" },
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    // No expressive instruction for non-Ultra voice
    const systemMsg = aiBody.messages.find((m) => m.role === "system").content;
    assert.ok(!/SSML emotion tags/.test(systemMsg), "non-Ultra voice must not get expressive instruction");
    // Plain payload, no tags
    assert.equal(speakBody.payload, "Ugh, John Wick.");
  } finally {
    global.fetch = original;
  }
});


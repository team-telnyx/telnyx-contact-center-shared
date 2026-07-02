import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKFLOW_TESTING_PERSONAS,
  normalizePersona,
  personaInstruction,
  normalizeMaxSlotsPerTurn,
  resolveSlotCountForTurn,
  isUltraVoice,
  isXaiVoice,
  voiceExpressiveKind,
  voiceSupportsExpressive,
  personaEmotion,
  applyVoiceExpression,
  applyUltraExpression,
  buildPreviewSamplePrompt,
  handleWorkflowTestingFinalTranscription,
} from "../lib/call-generator/workflow-testing.mjs";
import { normalizeSteps } from "../lib/call-generator/actions.mjs";

// Workflow Testing caller behaviour: persona, max answers per turn (+ random),
// and Expressive Mode (Telnyx Ultra SSML emotion tags / xAI speech tags).

process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || "test-key";

test("normalizePersona accepts the Ultra emotion ids and falls back to neutral", () => {
  assert.equal(normalizePersona("angry"), "angry");
  assert.equal(normalizePersona("FRUSTRATED"), "frustrated");
  assert.equal(normalizePersona("disappointed"), "disappointed");
  assert.equal(normalizePersona("in_a_hurry"), "neutral"); // old id removed
  assert.equal(normalizePersona("nonsense"), "neutral");
  assert.equal(normalizePersona(undefined), "neutral");
});

test("personaInstruction returns text for non-neutral personas and empty for neutral", () => {
  assert.equal(personaInstruction("neutral"), "");
  assert.ok(personaInstruction("angry").toLowerCase().includes("angry"));
  assert.ok(personaInstruction("frustrated").toLowerCase().includes("frustrated"));
});

test("persona presets cover the supported Ultra emotion vocabulary", () => {
  const ids = WORKFLOW_TESTING_PERSONAS.map((p) => p.id);
  for (const e of ["angry", "excited", "content", "sad", "scared", "happy", "enthusiastic", "curious", "calm", "grateful", "affectionate", "sarcastic", "surprised", "confident", "hesitant", "apologetic", "determined", "frustrated", "disappointed"]) {
    assert.ok(ids.includes(e), `persona list should include ${e}`);
  }
  assert.ok(ids.includes("neutral"));
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
  assert.equal(resolveSlotCountForTurn({ maxSlotsPerTurn: 3, randomizeSlots: true }, () => 0), 1);
  assert.equal(resolveSlotCountForTurn({ maxSlotsPerTurn: 3, randomizeSlots: true }, () => 0.999), 3);
  for (let i = 0; i < 50; i += 1) {
    const n = resolveSlotCountForTurn({ maxSlotsPerTurn: 4, randomizeSlots: true });
    assert.ok(n >= 1 && n <= 4, `slot count ${n} out of range`);
  }
});

test("randomize is ignored when max is 1 (always single slot)", () => {
  assert.equal(resolveSlotCountForTurn({ maxSlotsPerTurn: 1, randomizeSlots: true }, () => 0.999), 1);
});

test("normalizeSteps preserves persona, slots, randomize and expressive on the protected step", () => {
  const [step] = normalizeSteps([
    { type: "workflow_testing", voice: "Telnyx.Ultra.Mia", persona: "frustrated", max_slots_per_turn: 3, randomize_slots: true, expressive: true },
  ]);
  assert.equal(step.persona, "frustrated");
  assert.equal(step.max_slots_per_turn, 3);
  assert.equal(step.randomize_slots, true);
  assert.equal(step.expressive, true);
});

test("normalizeSteps forces randomize off when max_slots_per_turn is 1", () => {
  const [step] = normalizeSteps([{ type: "workflow_testing", max_slots_per_turn: 1, randomize_slots: true }]);
  assert.equal(step.max_slots_per_turn, 1);
  assert.equal(step.randomize_slots, false);
});

test("normalizeSteps forces expressive off for voices that don't support it", () => {
  const [natural] = normalizeSteps([{ type: "workflow_testing", voice: "AWS.Polly.Joanna", expressive: true }]);
  assert.equal(natural.expressive, false);
  const [ultra] = normalizeSteps([{ type: "workflow_testing", voice: "Telnyx.Ultra.Mia", expressive: true }]);
  assert.equal(ultra.expressive, true);
  const [xai] = normalizeSteps([{ type: "workflow_testing", voice: "xAI.eve", expressive: true }]);
  assert.equal(xai.expressive, true);
});

test("normalizeSteps defaults persona to neutral on unknown value", () => {
  const [step] = normalizeSteps([{ type: "workflow_testing", persona: "bogus" }]);
  assert.equal(step.persona, "neutral");
  assert.equal(step.max_slots_per_turn, 1);
});

test("voice family detection", () => {
  assert.equal(isUltraVoice("Telnyx.Ultra.Mia"), true);
  assert.equal(isUltraVoice("telnyx.ultra.mia"), true);
  assert.equal(isUltraVoice("AWS.Polly.Joanna"), false);
  assert.equal(isXaiVoice("xAI.eve"), true);
  assert.equal(isXaiVoice("XAI.LEO"), true);
  assert.equal(isXaiVoice("Telnyx.Ultra.Mia"), false);
  assert.equal(voiceExpressiveKind("Telnyx.Ultra.Mia"), "ultra");
  assert.equal(voiceExpressiveKind("xAI.eve"), "xai");
  assert.equal(voiceExpressiveKind("AWS.Polly.Joanna"), null);
  assert.equal(voiceSupportsExpressive("Telnyx.Ultra.Mia"), true);
  assert.equal(voiceSupportsExpressive("xAI.eve"), true);
  assert.equal(voiceSupportsExpressive("AWS.Polly.Joanna"), false);
});

test("personaEmotion maps non-neutral personas to the matching Ultra emotion", () => {
  assert.equal(personaEmotion("neutral"), null);
  assert.equal(personaEmotion("angry"), "angry");
  assert.equal(personaEmotion("frustrated"), "frustrated");
  assert.equal(personaEmotion("disappointed"), "disappointed");
  assert.equal(personaEmotion("bogus"), null);
});

test("applyVoiceExpression: Ultra prepends an <emotion> tag only when expressive on + non-neutral", () => {
  assert.equal(
    applyVoiceExpression("I want a refund now.", { voice: "Telnyx.Ultra.Mia", persona: "angry", expressive: true }),
    '<emotion value="angry" />I want a refund now.'
  );
  // expressive off -> untouched
  assert.equal(
    applyVoiceExpression("I want a refund now.", { voice: "Telnyx.Ultra.Mia", persona: "angry", expressive: false }),
    "I want a refund now."
  );
  // neutral -> untouched
  assert.equal(
    applyVoiceExpression("Sure.", { voice: "Telnyx.Ultra.Mia", persona: "neutral", expressive: true }),
    "Sure."
  );
  // non-supported voice -> untouched even if expressive on
  assert.equal(
    applyVoiceExpression("I want a refund.", { voice: "AWS.Polly.Joanna", persona: "angry", expressive: true }),
    "I want a refund."
  );
});

test("applyVoiceExpression: xAI wraps/prefixes with a speech tag when expressive on", () => {
  // angry -> <loud> wrapper
  assert.equal(
    applyVoiceExpression("I want a refund now.", { voice: "xAI.eve", persona: "angry", expressive: true }),
    "<loud>I want a refund now.</loud>"
  );
  // hesitant -> [pause] inline prefix
  assert.equal(
    applyVoiceExpression("My name is John.", { voice: "xAI.eve", persona: "hesitant", expressive: true }),
    "[pause] My name is John."
  );
  // expressive off -> untouched
  assert.equal(
    applyVoiceExpression("My name is John.", { voice: "xAI.eve", persona: "hesitant", expressive: false }),
    "My name is John."
  );
});

test("applyVoiceExpression does not double-tag text that already starts with a tag", () => {
  const ultraAlready = '<emotion value="excited" />Great news!';
  assert.equal(applyVoiceExpression(ultraAlready, { voice: "Telnyx.Ultra.Mia", persona: "angry", expressive: true }), ultraAlready);
  const xaiAlready = "[laugh] That's funny.";
  assert.equal(applyVoiceExpression(xaiAlready, { voice: "xAI.eve", persona: "angry", expressive: true }), xaiAlready);
});

test("applyUltraExpression back-compat alias delegates with expressive on by default", () => {
  assert.equal(
    applyUltraExpression("Hi.", { voice: "Telnyx.Ultra.Mia", persona: "happy" }),
    '<emotion value="happy" />Hi.'
  );
});

test("buildPreviewSamplePrompt: Ultra + expressive tells the model to embed the persona emotion tag", () => {
  const msgs = buildPreviewSamplePrompt({ persona: "angry", voice: "Telnyx.Ultra.Mia", expressive: true });
  const sys = msgs.find((m) => m.role === "system").content;
  assert.ok(/20 words/.test(sys), "should cap at 20 words");
  assert.ok(/<emotion value="angry" \/>/.test(sys), "should reference the angry emotion tag");
  assert.ok(/angry/i.test(sys), "should carry the persona instruction");
});

test("buildPreviewSamplePrompt: xAI + expressive references xAI speech tags", () => {
  const msgs = buildPreviewSamplePrompt({ persona: "hesitant", voice: "xAI.eve", expressive: true });
  const sys = msgs.find((m) => m.role === "system").content;
  assert.ok(/xAI speech tags/.test(sys));
  assert.ok(/\[pause\]/.test(sys));
});

test("buildPreviewSamplePrompt: expressive off or unsupported voice -> no tag instruction", () => {
  const off = buildPreviewSamplePrompt({ persona: "angry", voice: "Telnyx.Ultra.Mia", expressive: false });
  assert.ok(!/<emotion/.test(off.find((m) => m.role === "system").content));
  const std = buildPreviewSamplePrompt({ persona: "angry", voice: "AWS.Polly.Joanna", expressive: true });
  const sysStd = std.find((m) => m.role === "system").content;
  assert.ok(!/<emotion/.test(sysStd));
  assert.ok(!/xAI speech tags/.test(sysStd));
  // still carries the persona behaviour
  assert.ok(/angry/i.test(sysStd));
});

// --- End-to-end: prompt + spoken payload via handleWorkflowTestingFinalTranscription
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

function runReply({ testing, reply, transcript = "Can I get your name?" }) {
  const captureUpdates = [];
  const ledgerRow = { id: "ledger-x", run_id: "run-x", call_control_id: "v3:GEN-LEG", result: { workflow_testing: testing } };
  const pool = makeReplyPool(ledgerRow, captureUpdates);
  let aiBody = null;
  let speakBody = null;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes("/ai/chat/completions")) { aiBody = JSON.parse(options.body); return { ok: true, async json() { return { choices: [{ message: { content: reply } }] }; } }; }
    if (u.includes("/actions/speak")) { speakBody = JSON.parse(options.body); return { ok: true, async json() { return {}; } }; }
    return { ok: false, status: 404, async text() { return "nope"; } };
  };
  return handleWorkflowTestingFinalTranscription({
    pool,
    interaction: { id: "int-x", from_number: "+48221811540" },
    payload: { from: "+48221811540" },
    transcriptionData: { transcript, is_final: true },
    assistConfig: { assist_type: "workflows", workflow_id: "wf-1" },
  }).then((res) => ({ res, aiBody, speakBody, captureUpdates })).finally(() => { global.fetch = original; });
}

test("persona + multi-slot config reach the prompt", async () => {
  const { res, aiBody } = await runReply({
    testing: { enabled: true, workflow_id: "wf-1", voice: "Telnyx.Ultra.Mia", history: [], persona: "angry", max_slots_per_turn: 3, randomize_slots: false, expressive: false },
    reply: "Yeah whatever, John Wick.",
    transcript: "Can I get your name, facility and date of birth?",
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const systemMsg = aiBody.messages.find((m) => m.role === "system").content;
  assert.ok(systemMsg.toLowerCase().includes("angry"));
  assert.ok(/UP TO 3/.test(systemMsg));
  const userMsg = JSON.parse(aiBody.messages.find((m) => m.role === "user").content);
  assert.equal(userMsg.persona, "angry");
  assert.equal(userMsg.max_information_pieces_this_turn, 3);
});

test("Ultra + expressive ON: emotion-tagged payload + Ultra prompt hint, clean history", async () => {
  const { res, aiBody, speakBody, captureUpdates } = await runReply({
    testing: { enabled: true, workflow_id: "wf-1", voice: "Telnyx.Ultra.Mia", history: [], persona: "angry", max_slots_per_turn: 1, randomize_slots: false, expressive: true },
    reply: "Finally, my name is John Wick.",
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const systemMsg = aiBody.messages.find((m) => m.role === "system").content;
  assert.ok(/SSML emotion tags/.test(systemMsg));
  assert.equal(speakBody.payload, '<emotion value="angry" />Finally, my name is John Wick.');
  assert.equal(speakBody.voice, "Telnyx.Ultra.Mia");
  assert.equal(res.reply, "Finally, my name is John Wick.");
  const hist = captureUpdates.at(-1).workflow_testing.history;
  assert.ok(!/emotion/.test(hist.at(-1).text), "history must stay clean");
});

test("Ultra + expressive OFF: no tag in payload and no expressive prompt hint", async () => {
  const { res, aiBody, speakBody } = await runReply({
    testing: { enabled: true, workflow_id: "wf-1", voice: "Telnyx.Ultra.Mia", history: [], persona: "angry", max_slots_per_turn: 1, randomize_slots: false, expressive: false },
    reply: "My name is John Wick.",
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const systemMsg = aiBody.messages.find((m) => m.role === "system").content;
  assert.ok(!/SSML emotion tags/.test(systemMsg));
  assert.equal(speakBody.payload, "My name is John Wick.");
});

test("xAI + expressive ON: xAI speech tag in payload + xAI prompt hint", async () => {
  const { res, aiBody, speakBody } = await runReply({
    testing: { enabled: true, workflow_id: "wf-1", voice: "xAI.eve", history: [], persona: "angry", max_slots_per_turn: 1, randomize_slots: false, expressive: true },
    reply: "I want a refund now.",
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const systemMsg = aiBody.messages.find((m) => m.role === "system").content;
  assert.ok(/xAI speech tags/.test(systemMsg));
  assert.equal(speakBody.payload, "<loud>I want a refund now.</loud>");
});

test("non-supported voice never injects tags regardless of expressive flag", async () => {
  const { res, aiBody, speakBody } = await runReply({
    testing: { enabled: true, workflow_id: "wf-1", voice: "AWS.Polly.Joanna", history: [], persona: "angry", max_slots_per_turn: 1, randomize_slots: false, expressive: true },
    reply: "Ugh, John Wick.",
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const systemMsg = aiBody.messages.find((m) => m.role === "system").content;
  assert.ok(!/SSML emotion tags/.test(systemMsg));
  assert.ok(!/xAI speech tags/.test(systemMsg));
  assert.equal(speakBody.payload, "Ugh, John Wick.");
});

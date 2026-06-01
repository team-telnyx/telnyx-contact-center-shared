import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("workflow analyze keeps LLM slot confidence separate from STT transcription confidence", async () => {
  const analyzeSource = await source("../app/api/agent-assist/workflow/analyze/route.js");

  assert.doesNotMatch(
    analyzeSource,
    /Math\.min\(llmConfidence,\s*normalizedTranscriptionConfidence\)/,
    "workflow item confidence_score must not be the min/average of LLM and STT confidence",
  );
  assert.match(
    analyzeSource,
    /confidence_score = \$4[\s\S]*completed\.extracted_value \|\| null,\s*llmConfidence,/,
    "workflow item confidence_score persisted to DB should be the LLM confidence",
  );
  assert.match(
    analyzeSource,
    /updates\.push\(\{[\s\S]*confidence:\s*llmConfidence,[\s\S]*llm_confidence:\s*llmConfidence,[\s\S]*transcription_confidence:\s*normalizedTranscriptionConfidence/,
    "analyze response should expose LLM and STT confidence separately",
  );
});

test("slot extraction can complete from either speaker instead of being blocked by agent completion_trigger", async () => {
  const analyzeSource = await source("../app/api/agent-assist/workflow/analyze/route.js");

  assert.match(
    analyzeSource,
    /item\.type === "slot"\s*\|\|\s*completionTrigger === "either"/,
    "slot items should be fillable from customer or agent utterances regardless of completion_trigger default",
  );
});

test("Agent Assist renders separate labels for STT bubble confidence and LLM item confidence", async () => {
  const componentSource = await source("../components/contact-center/AgentAssistWorkflow.jsx");

  assert.match(
    componentSource,
    /STT\s*Confidence|STT conf/i,
    "live transcription bubbles should label confidence as STT confidence",
  );
  assert.match(
    componentSource,
    /LLM\s*Confidence|LLM conf/i,
    "workflow item badges should label confidence as LLM confidence",
  );
  assert.match(
    componentSource,
    /const isAiFilled = completedBy === "ai" \|\| completedBy === "auto"/,
    "auto-filled workflow slots should still show the LLM confidence badge",
  );
});

test("workflow checklist surfaces LLM-suggested slot values, not only completed ones", async () => {
  const checklistSource = await source("../components/contact-center/WorkflowChecklist.jsx");

  // The analyze endpoint returns status "suggested" for 0.60-0.85 LLM confidence
  // and only writes slotsFilled for completed items. So the checklist must read
  // the proposed value from the item status (extracted_value) and render a
  // "suggested" branch, otherwise medium-confidence extractions vanish.
  assert.match(
    checklistSource,
    /status\.status === "suggested"|isSuggested/,
    "checklist item must recognize the suggested status emitted by the analyze endpoint",
  );
  assert.match(
    checklistSource,
    /slotValue \|\| status\.extracted_value|status\.extracted_value \|\| slotValue/,
    "checklist should fall back to the item status extracted_value when slotsFilled has no entry",
  );
});

test("agent transcription SSE payload preserves provider confidence for UI badges", async () => {
  const routerSource = await source("../lib/agent-assist-transcription-router.mjs");
  const webhookHandlerSource = await source("../lib/contact-center/webhook-handler.js");

  assert.match(
    routerSource,
    /confidence:\s*normalizeConfidence\(transcriptionData\.confidence\)/,
    "SSE transcription payload must include normalized STT confidence; otherwise the UI has nothing to render",
  );
  assert.match(
    webhookHandlerSource,
    /confidence:\s*normalizeConfidence\(transcriptionData\.confidence\)/,
    "native call.transcription webhook SSE payload must also include normalized STT confidence",
  );
});

test("STT confidence display must not block high-confidence LLM slot completion", async () => {
  const analyzeSource = await source("../app/api/agent-assist/workflow/analyze/route.js");

  assert.match(
    analyzeSource,
    /normalizedTranscriptionConfidence\s*!==\s*null\s*&&[\s\S]*normalizedTranscriptionConfidence\s*<\s*sttConfidenceThreshold/,
    "workflow analysis should compare provider STT confidence with the configured STT threshold",
  );
  assert.doesNotMatch(
    analyzeSource,
    /item\.type === "slot" && \(belowThreshold \|\| sttBelowThreshold\)/,
    "STT confidence is a display/review signal and must not prevent the pre-confidence slot completion behavior",
  );
  assert.match(
    analyzeSource,
    /const nextStatus = "completed"/,
    "high-confidence LLM slot extraction should still complete the workflow item just like before PR #555",
  );
});

test("workflow store applies analyze updates for completed, suggested, and auto-filled slots", async () => {
  const storeSource = await source("../lib/stores/workflow-store.js");

  // The analyze endpoint never returns status "pending"; it returns "completed"
  // (high LLM confidence) or "suggested" (0.60-0.85). PR #555 added a dead
  // `status === "pending"` branch, so suggested slots with extracted values
  // were silently dropped and never rendered in the UI.
  assert.doesNotMatch(
    storeSource,
    /update\.status === "pending" && update\.extracted_value/,
    'workflow store must not gate analyze updates on status "pending"; the endpoint emits "suggested" instead',
  );
  assert.match(
    storeSource,
    /update\.status === "completed"\s*\|\|\s*\(update\.status === "suggested" && update\.extracted_value\)/,
    'workflow store should apply suggested slot updates that carry an extracted value',
  );
});

test("analyze item-status UPDATE pins the status parameter type to avoid Postgres 42P08", async () => {
  const analyzeSource = await source("../app/api/agent-assist/workflow/analyze/route.js");

  // The status column is varchar; the 'completed' literal is text. Reusing a
  // bare $1 for both `status = $1` and `CASE WHEN $1 = 'completed'` makes
  // Postgres deduce two types for the same parameter and abort the whole
  // analyze request with 42P08 "inconsistent types deduced for parameter $1",
  // which silently left every workflow slot unfilled at runtime.
  assert.doesNotMatch(
    analyzeSource,
    /CASE WHEN \$1 = 'completed'/,
    "the status CASE must not compare a bare $1 against a text literal (causes 42P08)",
  );
  assert.match(
    analyzeSource,
    /status = \$1::varchar/,
    "the status assignment should pin $1 to varchar",
  );
  assert.match(
    analyzeSource,
    /CASE WHEN \$1::varchar = 'completed'/,
    "the status CASE should compare $1::varchar so the parameter type is unambiguous",
  );
});

test("batch workflow prompt preserves customer and agent speaker labels", async () => {
  const { buildBatchAnalysisPrompt } = await import("../lib/agent-assist/workflow-prompts.js");

  const { userPrompt } = buildBatchAnalysisPrompt({
    transcripts: [
      { speaker: "customer", transcript: "My first name is John" },
      { speaker: "agent", transcript: "Can I have your last name?" },
      { speaker: "inbound", transcript: "Applegate" },
      { speaker: "outbound", transcript: "Thank you" },
    ],
    pendingItems: [],
    slotsFilled: {},
  });

  assert.match(userPrompt, /\[1\] Customer: "My first name is John"/);
  assert.match(userPrompt, /\[2\] Agent: "Can I have your last name\?"/);
  assert.match(userPrompt, /\[3\] Customer: "Applegate"/);
  assert.match(userPrompt, /\[4\] Agent: "Thank you"/);
});

test("workflow analysis receives recent conversation context for split slot values", async () => {
  const componentSource = await source("../components/contact-center/AgentAssistWorkflow.jsx");
  const storeSource = await source("../lib/stores/workflow-store.js");
  const analyzerSource = await source("../lib/agent-assist/workflow-analyzer.js");

  assert.match(
    componentSource,
    /recentFinalTranscriptions/,
    "client should send recent final transcript segments, not only the latest phrase",
  );
  assert.match(
    storeSource,
    /recentTranscripts:\s*options\.recentTranscripts/,
    "workflow store should forward recent transcript context to the analyze API",
  );
  assert.match(
    analyzerSource,
    /buildBatchAnalysisPrompt/,
    "analyzer should use the batch prompt so split utterances like first name + last name can fill one slot",
  );
});

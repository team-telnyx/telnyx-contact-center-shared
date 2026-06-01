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

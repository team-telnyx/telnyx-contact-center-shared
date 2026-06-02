import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("workflow schema stores a per-workflow LLM confidence threshold with 0.95 default", async () => {
  const schema = await read("../lib/postgres-schema.mjs");

  assert.match(schema, /llm_confidence_threshold/);
  assert.match(schema, /DEFAULT 0\.95/);
  assert.match(schema, /CHECK \(llm_confidence_threshold >= 0(?:\.0)? AND llm_confidence_threshold <= 1(?:\.0)?\)/);
  assert.match(schema, /status IN \('pending', 'suggested', 'completed', 'skipped'\)/);
  assert.match(schema, /pg_get_constraintdef\(oid\) ILIKE '%status%'/);
  assert.match(schema, /FOR constraint_name IN/);
});

test("admin workflow API validates and persists llm_confidence_threshold", async () => {
  const route = await read("../app/api/admin/workflows/[id]/route.js");

  assert.match(route, /llm_confidence_threshold/);
  assert.match(route, /Number\.isFinite\(confidenceThreshold\)/);
  assert.match(route, /llm_confidence_threshold === null \|\| llm_confidence_threshold === ""/);
  assert.match(route, /confidenceThreshold < 0 \|\| confidenceThreshold > 1/);
  assert.match(route, /Math\.round\(confidenceThreshold \* 100\) \/ 100/);
});

test("live analyzer uses only the workflow threshold to split completed vs suggested values", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const analyzer = await read("../lib/agent-assist/workflow-analyzer.js");
  const prompts = await read("../lib/agent-assist/workflow-prompts.js");

  assert.match(route, /SELECT llm_model, llm_confidence_threshold FROM aa_workflows/);
  assert.match(route, /confidenceThreshold = normalizeConfidenceThreshold/);
  assert.match(route, /if \(item\.type === "slot"\) \{\s*shouldComplete = true;/);
  assert.match(route, /completed\.confidence >= confidenceThreshold/);
  assert.match(route, /'suggested'/);
  assert.match(route, /completed_by = 'ai'/);
  assert.match(route, /source_transcript = \$4/);
  assert.doesNotMatch(route, /confidence >= 0\.60/);
  assert.doesNotMatch(analyzer, /confidence < 0\.60/);
  assert.doesNotMatch(prompts, /0\.85-0\.94|0\.70-0\.84|0\.60-0\.69|Below 0\.60|auto-complete/);
  assert.match(prompts, /The application will compare your confidence score against the workflow's configured confidence threshold/);
});

test("live analyzer keeps suggested items eligible for later higher-confidence slot extraction", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");

  assert.match(route, /AND ist\.status IN \('pending', 'suggested'\)/);
  assert.doesNotMatch(route, /AND ist\.status = 'pending'/);
});

test("workflow UI analyzes every unprocessed final transcript, not only the latest one", async () => {
  const ui = await read("../components/contact-center/AgentAssistWorkflow.jsx");

  assert.match(ui, /const finalTranscriptionsToAnalyze = transcriptions\.filter/);
  assert.match(ui, /for \(const transcription of finalTranscriptionsToAnalyze\)/);
  assert.match(ui, /analyzedTranscriptionIdsRef\.current\.add\(transcription\.id\)/);
  assert.doesNotMatch(ui, /const latestTranscription = transcriptions\[transcriptions\.length - 1\]/);
});

test("workflow store keeps suggested slot values and exposes LLM confidence locally", async () => {
  const store = await read("../lib/stores/workflow-store.js");

  assert.match(store, /update\.status === "suggested"/);
  assert.match(store, /status: update\.status/);
  assert.match(store, /confidence_score: update\.confidence/);
  assert.match(store, /completed_by: update\.completed_by \|\| "ai"/);
  assert.match(store, /const nextStatus = slotDetail\?\.status \|\|/);
  assert.match(store, /status: nextStatus/);
});

test("agent workflow UI renders low-confidence suggested slots with a blinking red frame and confirm action", async () => {
  const ui = await read("../components/contact-center/AgentAssistWorkflow.jsx");

  assert.match(ui, /isLowConfidence/);
  assert.match(ui, /animate-pulse/);
  assert.match(ui, /ring-red-500/);
  assert.match(ui, /LLM/);
  assert.match(ui, /Confirm/);
  assert.match(ui, /handleConfirmSuggestedSlot/);
  assert.match(ui, /disabled=\{isCompleted \|\| isSkipped \|\| isLowConfidence\}/);
});

test("agent assist node exposes STT and LLM confidence display toggles below sentiment analysis", async () => {
  const editor = await read("../components/voice-flow/AgentAssistNodeEditor.jsx");
  const config = await read("../config/voice-flow-nodes.js");
  const engine = await read("../lib/voice-flow-engine.js");

  assert.match(editor, /Enable Sentiment Analysis[\s\S]*Enable STT Confidence[\s\S]*Enable LLM Confidence/);
  assert.match(editor, /handleChange\("enable_stt_confidence", checked\)/);
  assert.match(editor, /handleChange\("enable_llm_confidence", checked\)/);
  assert.match(config, /enable_stt_confidence:[\s\S]*default: true/);
  assert.match(config, /enable_llm_confidence:[\s\S]*default: true/);
  assert.match(engine, /agentAssistConfig\.enable_stt_confidence = processedConfig\.enable_stt_confidence !== false/);
  assert.match(engine, /agentAssistConfig\.enable_llm_confidence = processedConfig\.enable_llm_confidence !== false/);
});

test("agent workflow config can hide LLM confidence badges without changing slot processing", async () => {
  const ui = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  const analyzeRoute = await read("../app/api/agent-assist/workflow/analyze/route.js");

  assert.match(ui, /showLlmConfidence=\{showLlmConfidence\}/);
  assert.match(ui, /showLlmConfidence = true/);
  assert.match(ui, /showLlmConfidence && isAiFilled && confidenceScore !== null/);
  assert.match(ui, /isLowConfidence &&/);
  assert.match(analyzeRoute, /completed\.confidence >= confidenceThreshold/);
});

test("Edit Workflow modal exposes a 0-1 two-decimal LLM confidence threshold input", async () => {
  const page = await read("../app/(portal)/admin/workflows/[id]/page.jsx");

  assert.match(page, /llm_confidence_threshold/);
  assert.match(page, /LLM Confidence Threshold/);
  assert.match(page, /step="0\.01"/);
  assert.match(page, /min="0"/);
  assert.match(page, /max="1"/);
  assert.match(page, /Default: 0\.95/);
  assert.match(page, /workflowForm\.llm_confidence_threshold === null \|\| workflowForm\.llm_confidence_threshold === ""/);
  assert.match(page, /if \(f\.llm_confidence_threshold === ""\) return f/);
});

test("AI handoff respects workflow LLM threshold and keeps low-confidence slots suggested", async () => {
  const handoff = await read("../lib/agent-assist/ai-handoff-processor.js");

  assert.match(handoff, /w\.llm_confidence_threshold/);
  assert.match(handoff, /confidenceThreshold = normalizeConfidenceThreshold\(workflow\?\.llm_confidence_threshold\)/);
  assert.match(handoff, /const isTrusted = confidence === undefined \|\| confidence >= confidenceThreshold/);
  assert.match(handoff, /const nextStatus = isTrusted \? "completed" : "suggested"/);
  assert.match(handoff, /completedAtSql = isTrusted \? "NOW\(\)" : "NULL"/);
  assert.match(handoff, /\["pending", "suggested"\]\.includes\(i\.status\)/);
  assert.match(handoff, /slots_filled: slotsFilled/);
  assert.match(handoff, /slots_details: slotsDetails/);
  assert.match(handoff, /statusRow\?\.status \|\| \(Object\.prototype\.hasOwnProperty\.call\(slotsFilled, key\) \? "completed" : "suggested"\)/);
});

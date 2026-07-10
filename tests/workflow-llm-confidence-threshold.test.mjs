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
  assert.match(route, /completed\.confidence >= confidenceThreshold/);
  assert.match(route, /'suggested'/);
  assert.match(route, /completed_by = 'ai'/);
  assert.match(route, /source_transcript = \$4/);
  assert.doesNotMatch(route, /confidence >= 0\.60/);
  const testRoute = await read("../app/api/admin/workflows/[id]/analyze-test/route.js");
  assert.doesNotMatch(testRoute, /confidence >= 0\.60/);
  assert.doesNotMatch(analyzer, /confidence < 0\.60/);
  assert.match(analyzer, /typeof rawConfidence !== "number" && typeof rawConfidence !== "string"/);
  assert.match(analyzer, /typeof rawConfidence === "string" && rawConfidence\.trim\(\) === ""/);
  assert.doesNotMatch(prompts, /0\.85-0\.94|0\.70-0\.84|0\.60-0\.69|Below 0\.60|auto-complete/);
  assert.match(prompts, /The application will compare your confidence score against the workflow's configured confidence threshold/);
});

test("slot completion respects the item's configured speaker trigger and requires a value", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const testRoute = await read("../app/api/admin/workflows/[id]/analyze-test/route.js");
  const prompts = await read("../lib/agent-assist/workflow-prompts.js");
  const analyzer = await read("../lib/agent-assist/workflow-analyzer.js");

  for (const source of [route, testRoute]) {
    assert.doesNotMatch(source, /item\.type === "slot" \|\|/);
    assert.doesNotMatch(source, /if \(item\.type === "slot"\) \{\s*shouldComplete = true;/);
    assert.match(source, /const hasExtractedSlotValue = item\.type !== "slot" \|\| hasMeaningfulExtractedValue\(completed\.extracted_value\)/);
    assert.match(source, /if \(!shouldComplete \|\| !hasExtractedSlotValue\) \{\s*continue;/);
    assert.match(source, /Boolean\(speakerType\)/);
    assert.doesNotMatch(source, /!speakerType/);
    assert.match(source, /completionTrigger === "customer" && speakerType === "customer"/);
    assert.match(source, /completionTrigger === "agent" && speakerType === "agent"/);
  }

  assert.match(prompts, /Completion trigger: \$\{formatCompletionTrigger\(item\.completion_trigger\)\}/);
  assert.match(prompts, /Only evaluate an item when the transcript speaker matches its Completion trigger/);
  assert.match(prompts, /For slot items, extracted_value must be a non-empty concrete value from the matching speaker/);
  assert.match(prompts, /Do not complete a slot when the transcript only asks for the value/);

  assert.match(analyzer, /hasMeaningfulExtractedValue\(item\.extracted_value\)/);
  assert.match(analyzer, /pendingItem\.type === "slot" && !hasMeaningfulExtractedValue\(item\.extracted_value\)/);
  assert.match(analyzer, /item\.confidence = confidence;\s*return true;/);
});

test("live analyzer keeps suggested items eligible for later higher-confidence slot extraction", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");

  assert.match(route, /AND ist\.status IN \('pending', 'suggested'\)/);
  assert.doesNotMatch(route, /AND ist\.status = 'pending'/);
});

test("workflow UI analyzes every unprocessed final transcript, not only the latest one", async () => {
  const ui = await read("../components/contact-center/AgentAssistWorkflow.jsx");

  assert.match(ui, /const finalTranscriptionsToAnalyze = transcriptions\.filter/);
  // Every unprocessed final is analyzed: the fired batch is derived from
  // finalTranscriptionsToAnalyze and each item is dispatched (#1211).
  assert.match(ui, /const batch = finalTranscriptionsToAnalyze\.filter/);
  assert.match(ui, /for \(const transcription of batch\)/);
  assert.match(ui, /analyzedTranscriptionIdsRef\.current\.add\(t\.id\)/);
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

test("agent workflow UI renders low-confidence suggested slots with a subdued amber highlight and confirm action", async () => {
  const ui = await read("../components/contact-center/AgentAssistWorkflow.jsx");

  assert.match(ui, /isLowConfidence/);
  assert.match(ui, /bg-amber-500\/10 border-l-2 border-amber-500/);
  assert.doesNotMatch(ui, /animate-pulse/);
  assert.doesNotMatch(ui, /ring-red-500/);
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

test("intent and sentiment transcription analysis uses workflow settings model instead of hardcoded Kimi", async () => {
  const sentiment = await read("../lib/agent-assist/sentiment-analysis.js");
  const router = await read("../lib/agent-assist-transcription-router.mjs");
  const webhookHandler = await read("../lib/contact-center/webhook-handler.js");

  assert.match(sentiment, /analyzeTranscription\(transcript, \{ model \} = \{\}\)/);
  assert.match(sentiment, /model: model \|\| DEFAULT_AGENT_ASSIST_LLM_MODEL/);
  assert.doesNotMatch(sentiment, /model: "moonshotai\/Kimi-K2\.5"/);

  assert.match(router, /resolveAgentAssistAnalysisModel\(assistConfig\)/);
  assert.match(router, /SELECT llm_model FROM aa_workflows WHERE id = \$1/);
  assert.match(router, /analyzeTranscription\(transcriptionData\.transcript, \{ model: analysisModel \}\)/);

  assert.match(webhookHandler, /resolveAgentAssistAnalysisModel\(assistConfig\)/);
  assert.match(webhookHandler, /SELECT llm_model FROM aa_workflows WHERE id = \$1/);
  assert.match(webhookHandler, /analyzeTranscription\(transcriptionData\.transcript, \{ model: analysisModel \}\)/);

  const runtimeFiles = [
    sentiment,
    router,
    webhookHandler,
    await read("../lib/agent-assist/workflow-analyzer.js"),
    await read("../lib/agent-assist/generate-test-scenario.js"),
    await read("../app/api/agent-assist/workflow/analyze/route.js"),
    await read("../app/api/agent-assist/workflow/generate-suggestion/route.js"),
    await read("../app/api/admin/workflows/[id]/analyze-test/route.js"),
    await read("../app/api/admin/workflows/[id]/generate-test-scenario/route.js"),
    await read("../app/api/admin/workflows/[id]/generate-response/route.js"),
  ];
  for (const source of runtimeFiles) {
    assert.doesNotMatch(source, /moonshotai\/Kimi-K2\.5/);
  }
});

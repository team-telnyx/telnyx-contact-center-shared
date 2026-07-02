import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("Agent Assist node exposes and persists Show expanded stages for workflow assist", async () => {
  const configSource = await source("../config/voice-flow-nodes.js");
  const editorSource = await source("../components/voice-flow/AgentAssistNodeEditor.jsx");
  const engineSource = await source("../lib/voice-flow-engine.js");

  assert.match(configSource, /show_expanded_stages:\s*\{[\s\S]*label:\s*"Show expanded stages"[\s\S]*showWhen:\s*\{ assist_type:\s*"workflows" \}/);
  assert.match(editorSource, /<Label>Show expanded stages<\/Label>[\s\S]*checked=\{config\.show_expanded_stages === true\}[\s\S]*handleChange\("show_expanded_stages", checked\)/);
  assert.match(engineSource, /agentAssistConfig\.show_expanded_stages\s*=\s*processedConfig\.show_expanded_stages === true/);
});

test("Agent Assist workflow checklist supports all-expanded accordions, item auto-scroll, and stage alerts", async () => {
  const workflowSource = await source("../components/contact-center/AgentAssistWorkflow.jsx");

  assert.match(workflowSource, /showExpandedStages=\{assistConfig\.show_expanded_stages === true\}/);
  assert.match(workflowSource, /function WorkflowStagesCard\([\s\S]*showExpandedStages = false/);
  assert.match(workflowSource, /<Accordion[\s\S]*type=\{showExpandedStages \? "multiple" : "single"\}/);
  assert.match(workflowSource, /value=\{showExpandedStages \? expandedStages : expandedStage\}/);
  assert.match(workflowSource, /itemRefs\.current\[changedItemId\]\?\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
  assert.match(workflowSource, /data-workflow-item-id=\{item\.id\}/);
  assert.match(workflowSource, /getStageVerificationAlert\(stage, itemStatuses, completedBlinkStageIds\)/);
  assert.match(workflowSource, /type: "needs-confirmation"[\s\S]*border-amber-500\/60 bg-amber-500\/5/);
  assert.match(workflowSource, /type: "completed-recently"[\s\S]*border-emerald-500\/40 bg-emerald-500\/5/);
});

test("Agent Assist workflow stage blink keyframes are defined globally", async () => {
  const globalsSource = await source("../app/globals.css");
  assert.match(globalsSource, /@keyframes stageBlink/);
  assert.match(globalsSource, /50%\s*\{[\s\S]*box-shadow:[\s\S]*0 0 0 3px/);
});

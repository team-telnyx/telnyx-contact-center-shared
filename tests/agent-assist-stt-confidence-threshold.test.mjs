import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("workflow analysis keeps STT confidence separate from workflow LLM confidence", async () => {
  const routeSource = await source("../app/api/agent-assist/workflow/analyze/route.js");

  assert.match(
    routeSource,
    /const workflowConfidenceThreshold = 0\.85;/,
    "workflow item threshold should be based on LLM extraction confidence, not STT confidence",
  );
  assert.match(
    routeSource,
    /const belowThreshold = llmConfidence < workflowConfidenceThreshold;/,
    "belowThreshold for workflow items should compare LLM confidence with the workflow confidence threshold",
  );
  assert.doesNotMatch(
    routeSource,
    /Math\.min\(llmConfidence,\s*normalizedTranscriptionConfidence\)/,
    "LLM and STT confidence should never be collapsed into one computed score",
  );
  assert.match(
    routeSource,
    /transcription_confidence:\s*normalizedTranscriptionConfidence/,
    "STT confidence should still be returned separately for UI diagnostics",
  );
});

test("workflow session reload preserves pending auto-filled slot verification state", async () => {
  const sessionRouteSource = await source("../app/api/agent-assist/workflow/session/route.js");

  assert.match(
    sessionRouteSource,
    /below_threshold:\s*status\.status !== "completed" &&\s*status\.completed_by === "auto" &&\s*status\.extracted_value !== null/,
    "pending auto-filled slots with extracted values should reload as needing verification",
  );
});

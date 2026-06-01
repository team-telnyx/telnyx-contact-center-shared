import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("workflow analysis applies STT threshold only to transcription confidence", async () => {
  const routeSource = await source("../app/api/agent-assist/workflow/analyze/route.js");

  assert.match(
    routeSource,
    /const belowThreshold =\s*normalizedTranscriptionConfidence !== null &&\s*normalizedTranscriptionConfidence < sttConfidenceThreshold;/,
    "belowThreshold should be based on STT confidence, not combined LLM confidence",
  );
  assert.match(
    routeSource,
    /if \(shouldComplete && llmConfidence >= 0\.85\)/,
    "LLM confidence should continue to gate auto-completion separately",
  );
  assert.doesNotMatch(
    routeSource,
    /const belowThreshold = computedConfidence < sttConfidenceThreshold;/,
    "combined confidence should not be compared with the STT threshold",
  );
});

test("workflow session reload rehydrates low-confidence pending slot state", async () => {
  const sessionRouteSource = await source("../app/api/agent-assist/workflow/session/route.js");

  assert.match(
    sessionRouteSource,
    /below_threshold:\s*status\.status !== "completed" &&\s*status\.completed_by === "auto" &&\s*status\.extracted_value !== null/,
    "pending auto-filled slots with extracted values should reload as below-threshold",
  );
  assert.match(
    sessionRouteSource,
    /threshold: session\.stt_confidence_threshold/,
    "rehydrated statuses should expose the workflow STT threshold to the UI",
  );
});

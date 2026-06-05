import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ui = () => readFile(new URL("../components/contact-center/AgentAssistWorkflow.jsx", import.meta.url), "utf8");
const route = () => readFile(new URL("../app/api/agent-assist/workflow/generate-suggestion/route.js", import.meta.url), "utf8");

test("suggested responses use a conversation-aware target resolver instead of first pending item", async () => {
  const source = await ui();

  assert.match(source, /resolveSuggestedResponseTarget/);
  assert.doesNotMatch(source, /const currentSlotNeedingFill = useMemo\(\(\) => \{[\s\S]*?for \(const stage of stages\)[\s\S]*?return \{ stage, item \};[\s\S]*?\}, \[stages, itemStatuses, slotsFilled\]\);/);
  assert.match(source, /currentSuggestionTarget/);
  assert.match(source, /conversationContext/);
  assert.match(source, /targetMode/);
  assert.match(source, /blockedItem/);
});

test("generate suggestion endpoint accepts target mode and workflow context for asynchronous guidance", async () => {
  const source = await route();

  assert.match(source, /targetMode/);
  assert.match(source, /conversationContext/);
  assert.match(source, /blockedItem/);
  assert.match(source, /itemStatus/);
  assert.match(source, /capturedSlotValue/);
  assert.match(source, /Captured value/);
  assert.match(source, /collect_prerequisite/);
  assert.match(source, /confirm_slot/);
  assert.match(source, /Do not jump back to the first pending workflow item/);
});

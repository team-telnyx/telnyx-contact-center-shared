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

test("confirm slot suggestions prefer corrected filled slot values over stale suggested captures", async () => {
  const source = await route();

  assert.match(
    source,
    /const prefilledValue = slotName \? prefilledSlots\?\.\[slotName\] : null;[\s\S]*?if \(hasMeaningfulValue\(prefilledValue\)\) return prefilledValue;[\s\S]*?const statusValue = itemStatus\?\.extracted_value \?\? itemStatus\?\.value;/
  );
});

// Reported live: "How can I help you today?" (a NON-SLOT "question" item)
// stayed in the Suggested Responses panel after the caller had already
// stated their intent. Root cause: the accumulating suggestions list only
// ever dropped a card once its item's status flipped to literal
// "completed" — but a non-slot item can sit at "suggested" (or with no
// status at all) forever if its own completion detection never lands,
// since there is no explicit "Confirm" action for it the way there is for
// a low-confidence slot.
test("suggestions list drops a stale NON-SLOT card once a later item in the same stage shows progress, not just on literal completion", async () => {
  const source = await ui();

  assert.match(source, /import \{ resolveSuggestedResponseTarget, isItemStillRelevantInStage \} from "@\/lib\/agent-assist\/suggestion-target-resolver\.mjs";/);
  assert.match(source, /if \(status\?\.status === "completed"\) return false;/);
  assert.match(
    source,
    /const candidate = findStageAndItemById\(stages, s\.itemId\);\s*\n\s*if \(candidate && !isItemStillRelevantInStage\(candidate\.item, candidate\.stage, itemStatuses, slotsFilled\)\) \{\s*\n\s*return false;/
  );
});

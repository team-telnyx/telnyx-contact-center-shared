import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("slot collection prompts use natural phrasing, not 'provide your <label>'", async () => {
  const route = await read("../app/api/agent-assist/workflow/generate-suggestion/route.js");

  // Prerequisite/correction noun-phrasing helper exists (possessive "patient
  // X", acronyms restored).
  assert.match(route, /function slotNounPhrase\(label\)/);
  assert.match(route, /replace\(\/\^patient\\b\(\?!'\)\/, "patient's"\)/);
  assert.match(route, /\\biv\\b\/g, "IV"/);
  // The stilted template is gone from the slot-collection paths.
  assert.doesNotMatch(route, /Could you please provide your \$\{labelLower\}\?/);
  // Deterministic slot-collection paths (conversation_stage_match and the
  // allowGeneric LLM-empty fallback) route through the fast-template resolver
  // (MEDICAL_TRANSPORT_SLOT_TEMPLATES / SAY: hints) instead of a raw generic
  // phrase directly — a bare local phraseSlotCollection(label) call here
  // would bypass any configured template entirely (see the reported "every
  // slot shows 'Could you provide X?'" bug: conversationContext.reason ===
  // "conversation_stage_match" short-circuited before slotName was even
  // threaded through).
  assert.match(route, /if \(conversationContext\?\.reason === "conversation_stage_match" && itemType === "slot"\) \{\s*\n[\s\S]*?return resolveFastSuggestionTemplate\(\{/);
  assert.match(route, /if \(allowGeneric && itemType === "slot"\) \{\s*\n[\s\S]*?return resolveFastSuggestionTemplate\(\{/);
  // Both deterministic slot-collection call sites pass slotName through, so
  // the resolver can actually find a configured template.
  const deterministicCalls = route.match(/return resolveFastSuggestionTemplate\(\{[\s\S]*?\}\);/g) || [];
  assert.equal(deterministicCalls.length, 2);
  for (const call of deterministicCalls) {
    assert.match(call, /slotName,/);
  }
});

test("client static fallback also avoids 'provide your <label>' and double '??'", async () => {
  const cmp = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.doesNotMatch(cmp, /Could you please provide your \$\{item\.label\.toLowerCase\(\)\}\?/);
  assert.match(cmp, /item\.label\.trim\(\)\.endsWith\("\?"\)/);
});

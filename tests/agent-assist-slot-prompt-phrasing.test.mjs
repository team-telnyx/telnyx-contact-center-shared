import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("slot collection prompts use natural phrasing, not 'provide your <label>'", async () => {
  const route = await read("../app/api/agent-assist/workflow/generate-suggestion/route.js");

  // Helpers exist.
  assert.match(route, /function slotNounPhrase\(label\)/);
  assert.match(route, /function phraseSlotCollection\(label\)/);
  // Question-labels are asked verbatim (no "provide your ...??").
  assert.match(route, /if \(raw\.endsWith\("\?"\)\) return raw\.charAt\(0\)\.toUpperCase\(\) \+ raw\.slice\(1\);/);
  // "patient X" becomes possessive; acronyms restored.
  assert.match(route, /replace\(\/\^patient\\b\(\?!'\)\/, "patient's"\)/);
  assert.match(route, /\\biv\\b\/g, "IV"/);
  // The stilted template is gone from the slot-collection paths.
  assert.doesNotMatch(route, /Could you please provide your \$\{labelLower\}\?/);
  // Collection paths call the new phrasing.
  assert.match(route, /return phraseSlotCollection\(label\);/);
});

test("client static fallback also avoids 'provide your <label>' and double '??'", async () => {
  const cmp = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.doesNotMatch(cmp, /Could you please provide your \$\{item\.label\.toLowerCase\(\)\}\?/);
  assert.match(cmp, /item\.label\.trim\(\)\.endsWith\("\?"\)/);
});

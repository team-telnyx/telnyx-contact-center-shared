import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = () =>
  readFile(new URL("../app/api/agent-assist/workflow/generate-suggestion/route.js", import.meta.url), "utf8");

test("opening greeting is brand-forward ('thanks for calling'), not agent-name", async () => {
  const route = await read();
  assert.match(route, /Hi, thanks for \$\{brandPhrase\}\. How can I help you today\?/);
  // The old "Hello, I'm <agent>. I'll be helping you today." greeting is gone.
  assert.doesNotMatch(route, /Hello, I'm \$\{finalAgentName\}\. I'll be helping you today\./);
  assert.doesNotMatch(route, /Hello, I'm calling from \$\{brand\}\. I'll be helping you today\./);
});

test("greeting requires greeting WORDING on a NON-slot item (Codex #1184: no first-item hijack)", async () => {
  const route = await read();
  // Must be a non-slot item AND match greeting/help wording — not isFirstItem alone.
  assert.match(route, /const looksLikeOpeningGreeting =\s*\n\s*itemType !== "slot" &&/);
  assert.match(route, /how \(can\|may\|to\)/);
  // isFirstItem is no longer OR'd into the greeting condition.
  assert.doesNotMatch(route, /isFirstItem \|\|/);
});

test("greeting drops the 'the company' placeholder when no brand is configured (Codex #1184)", async () => {
  const route = await read();
  // A brandless "thanks for calling" instead of "thanks for calling the company".
  assert.match(route, /brand !== "the company" \? `calling \$\{brand\}` : "calling"/);
});

test("LLM fallback guidance is brand-forward, not agent-name", async () => {
  const route = await read();
  assert.match(route, /thank the caller for calling \$\{brand\}/);
  assert.match(route, /never say "the company"/);
  assert.doesNotMatch(route, /introduce the agent by name when known/);
});

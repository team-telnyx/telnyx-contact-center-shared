// Tests for the shared, client-safe persona/expression module and the
// Test AI Agent "generate-response" wiring. Guards the consistency contract
// between the browser Test AI Agent page and the Call Generator workflow tester.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as shared from "../lib/call-generator/persona-expression.mjs";
import * as workflowTesting from "../lib/call-generator/workflow-testing.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

test("shared persona module exposes the full 20-persona vocabulary (neutral + 19 Ultra emotions)", () => {
  assert.equal(shared.WORKFLOW_TESTING_PERSONAS.length, 20);
  assert.equal(shared.WORKFLOW_TESTING_PERSONAS[0].id, "neutral");
  // Every non-neutral persona id must be a valid Ultra emotion (1:1 alignment).
  for (const p of shared.WORKFLOW_TESTING_PERSONAS.slice(1)) {
    assert.ok(shared.ULTRA_EMOTIONS.includes(p.id), `persona ${p.id} should be an Ultra emotion`);
  }
});

test("workflow-testing.mjs re-exports the same persona list (single source of truth)", () => {
  assert.deepEqual(
    workflowTesting.WORKFLOW_TESTING_PERSONAS,
    shared.WORKFLOW_TESTING_PERSONAS,
  );
  // Re-exported functions are the exact same references.
  assert.equal(workflowTesting.applyVoiceExpression, shared.applyVoiceExpression);
  assert.equal(workflowTesting.normalizePersona, shared.normalizePersona);
  assert.equal(workflowTesting.voiceExpressiveKind, shared.voiceExpressiveKind);
});

test("shared module is client-safe: no server-only imports (logger / db / engine)", () => {
  const src = readFileSync(
    join(repoRoot, "lib/call-generator/persona-expression.mjs"),
    "utf8",
  );
  assert.ok(!/diagnostic-logger/.test(src), "must not import the diagnostic logger");
  assert.ok(!/postgres/.test(src), "must not import postgres");
  assert.ok(!/from\s+["']\.\/engine/.test(src), "must not import the generator engine");
  assert.ok(!/buildTelnyxV2Url/.test(src), "must not import telnyx url builder (server side)");
});

test("applyVoiceExpression matches Call Generator behaviour for Ultra + xAI", () => {
  // Ultra: emotion tag prepended only when expressive + non-neutral.
  assert.equal(
    shared.applyVoiceExpression("I'm so done with this.", {
      voice: "Telnyx.Ultra.Asteria",
      persona: "frustrated",
      expressive: true,
    }),
    '<emotion value="frustrated" />I\'m so done with this.',
  );
  // Neutral never tags.
  assert.equal(
    shared.applyVoiceExpression("Hello.", {
      voice: "Telnyx.Ultra.Asteria",
      persona: "neutral",
      expressive: true,
    }),
    "Hello.",
  );
  // xAI: speech tag wrapping/prefix.
  const xai = shared.applyVoiceExpression("Right now please.", {
    voice: "xAI.Grok",
    persona: "angry",
    expressive: true,
  });
  assert.ok(/<loud>/.test(xai), "xAI angry should use <loud> wrapper");
  // Expressive off → untouched.
  assert.equal(
    shared.applyVoiceExpression("Plain.", {
      voice: "Telnyx.Ultra.Asteria",
      persona: "angry",
      expressive: false,
    }),
    "Plain.",
  );
  // Unsupported voice → untouched even when expressive on.
  assert.equal(
    shared.applyVoiceExpression("Plain.", {
      voice: "AWS.Polly.Joanna",
      persona: "angry",
      expressive: true,
    }),
    "Plain.",
  );
});

test("Test AI Agent page imports the shared module and applies expression before TTS", () => {
  const page = readFileSync(
    join(repoRoot, "app/(portal)/admin/workflows/[id]/test/page.jsx"),
    "utf8",
  );
  // Imports the shared client-safe module (not the server workflow-testing.mjs).
  assert.ok(
    /from\s+["']@\/lib\/call-generator\/persona-expression\.mjs["']/.test(page),
    "page should import from persona-expression.mjs",
  );
  // Default persona is the shared 'neutral', not the old 'cooperative'.
  assert.ok(/useState\("neutral"\)/.test(page), "default persona should be neutral");
  assert.ok(!/useState\("cooperative"\)/.test(page), "old 'cooperative' default must be gone");
  // Expression is applied to the spoken text before generateTTS.
  assert.ok(/applyVoiceExpression\(/.test(page), "page should apply voice expression");
  assert.ok(/generateTTS\(spokenText/.test(page), "TTS should use the expressive spokenText");
  // Expressive Mode + voice are forwarded to generate-response.
  assert.ok(/expressive:\s*expressiveRef\.current/.test(page), "expressive forwarded to API");
  assert.ok(/voice:\s*ttsVoiceRef\.current/.test(page), "voice forwarded to API");
});

test("generate-response route reuses the shared persona/slot/expression helpers", () => {
  const route = readFileSync(
    join(repoRoot, "app/api/admin/workflows/[id]/generate-response/route.js"),
    "utf8",
  );
  assert.ok(
    /from\s+["']@\/lib\/call-generator\/workflow-testing\.mjs["']/.test(route),
    "route should import shared helpers from workflow-testing.mjs",
  );
  assert.ok(/resolveSlotCountForTurn/.test(route), "route should use slot-count discipline");
  assert.ok(/voiceExpressiveKind/.test(route), "route should gate expression by voice family");
  assert.ok(/personaInstruction/.test(route), "route should use shared persona instructions");
  // Old weak 5-persona PERSONAS object must be gone.
  assert.ok(!/cooperative:\s*\{/.test(route), "old hardcoded PERSONAS must be removed");
});

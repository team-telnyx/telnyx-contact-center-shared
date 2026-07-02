import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { normalizeSteps, describeStep } from "../lib/call-generator/actions.mjs";

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// --- Delay action step ------------------------------------------------------

test("normalizeSteps accepts a delay step and clamps delay_ms to [100, 30000]", () => {
  const [a] = normalizeSteps([{ type: "delay", delay_ms: 2500 }]);
  assert.deepStrictEqual(a, { type: "delay", delay_ms: 2500 });

  const [tooSmall] = normalizeSteps([{ type: "delay", delay_ms: 5 }]);
  assert.equal(tooSmall.delay_ms, 100);

  const [tooBig] = normalizeSteps([{ type: "delay", delay_ms: 999999 }]);
  assert.equal(tooBig.delay_ms, 30000);

  const [missing] = normalizeSteps([{ type: "delay" }]);
  assert.equal(missing.delay_ms, 1000); // default
});

test("delay can be interleaved with other steps and survives normalization", () => {
  const steps = normalizeSteps([
    { type: "play_media", media_name: "intro.wav" },
    { type: "delay", delay_ms: 1500 },
    { type: "send_dtmf", digits: "123" },
  ]);
  assert.deepStrictEqual(steps.map((s) => s.type), ["play_media", "delay", "send_dtmf"]);
  assert.equal(steps[1].delay_ms, 1500);
});

test("describeStep renders the delay in seconds", () => {
  assert.equal(describeStep({ type: "delay", delay_ms: 2000 }), "Delay 2s");
});

test("the engine sleeps for a delay step between commands", () => {
  const engine = read("lib/call-generator/engine.mjs");
  assert.match(engine, /step\.type === "delay"/);
  assert.match(engine, /setTimeout\(resolve, ms\)/);
});

// --- Workflow Testing reply delay ------------------------------------------

test("normalizeSteps carries reply_delay_ms on the workflow_testing step, clamped to [0, 10000]", () => {
  const [step] = normalizeSteps([{ type: "workflow_testing", reply_delay_ms: 1500 }]);
  assert.equal(step.reply_delay_ms, 1500);

  const [clampedHigh] = normalizeSteps([{ type: "workflow_testing", reply_delay_ms: 99999 }]);
  assert.equal(clampedHigh.reply_delay_ms, 10000);

  const [missing] = normalizeSteps([{ type: "workflow_testing" }]);
  assert.equal(missing.reply_delay_ms, 0); // default: reply immediately
});

test("workflow-testing reply handler waits reply_delay_ms before generating the reply", () => {
  const wt = read("lib/call-generator/workflow-testing.mjs");
  assert.match(wt, /reply_delay_ms/);
  assert.match(wt, /setTimeout\(resolve, replyDelayMs\)/);
  // The delay must happen before the LLM reply generation call inside the handler.
  const delayIdx = wt.indexOf("setTimeout(resolve, replyDelayMs)");
  const genIdx = wt.indexOf("const reply = await generateWorkflowTestingReply({");
  assert.ok(delayIdx > 0 && genIdx > 0 && delayIdx < genIdx, "delay must precede reply generation");
});

test("runner seeds reply_delay_ms into the ledger workflow_testing config", () => {
  const runner = read("lib/call-generator/runner.mjs");
  assert.match(runner, /reply_delay_ms:/);
});

// --- UI: Delay button + Reply delay field + InfoHints -----------------------

test("call-generator page exposes a Delay add-step button in a 2-column grid", () => {
  const page = read("app/(portal)/admin/call-generator/page.jsx");
  assert.match(page, /grid grid-cols-2 gap-2/);
  assert.match(page, /addStep\("delay"\)/);
  assert.match(page, />\s*Delay\s*<\/Button>/);
  // DTMF and Delay live together in the new row (both still present as buttons).
  assert.match(page, /addStep\("send_dtmf"\)/);
});

test("call-generator page moves the listed descriptions into InfoHints", () => {
  const page = read("app/(portal)/admin/call-generator/page.jsx");
  // The descriptions are now rendered as InfoHint hint props, not inline <p> help text.
  assert.match(page, /function InfoHint\(/);
  assert.match(page, /function LabelWithHint\(/);
  assert.match(page, /Reply delay \(seconds\)/);
  // A couple of the relocated descriptions still exist (as hints).
  assert.match(page, /Shapes how the simulated caller behaves/);
  assert.match(page, /How many distinct pieces of information the caller may give/);
  assert.match(page, /each turn reveals a random number of pieces/);
});

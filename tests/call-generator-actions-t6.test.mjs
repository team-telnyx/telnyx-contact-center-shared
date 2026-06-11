import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { normalizeSteps, describeStep } from "../lib/call-generator/actions.mjs";
import { normalizeTargets } from "../lib/call-generator/runner.mjs";

async function src(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("call generator actions & multi-target (T6)", () => {
  it("normalizeSteps keeps valid play_media/speak/send_dtmf and drops garbage", () => {
    const steps = normalizeSteps([
      { type: "play_media", media_name: "welcome.mp3" },
      { type: "speak", text: "This is a test call", voice: "AWS.Polly.Joanna" },
      { type: "send_dtmf", digits: "3467" },
      { type: "send_dtmf", digits: "12w3#*abXYZ" }, // strips invalid chars (X,Y,Z)
      { type: "play_media", media_name: "" },
      { type: "speak", text: "" },
      { type: "send_dtmf", digits: "!!!" },
      { type: "unknown" },
      null,
    ]);
    assert.strictEqual(steps.length, 4);
    assert.deepStrictEqual(steps[0], { type: "play_media", media_name: "welcome.mp3" });
    assert.strictEqual(steps[1].type, "speak");
    assert.strictEqual(steps[1].voice, "AWS.Polly.Joanna");
    assert.strictEqual(steps[2].digits, "3467");
    assert.strictEqual(steps[3].digits, "12w3#*ab");
  });

  it("speak step defaults voice and clamps text length", () => {
    const steps = normalizeSteps([{ type: "speak", text: "x".repeat(5000) }]);
    assert.strictEqual(steps[0].voice, "AWS.Polly.Joanna");
    assert.strictEqual(steps[0].text.length, 3000);
  });

  it("describeStep renders human-readable labels", () => {
    assert.strictEqual(describeStep({ type: "play_media", media_name: "a.mp3" }), "Play media a.mp3");
    assert.match(describeStep({ type: "speak", text: "Hello" }), /Speak "Hello"/);
    assert.strictEqual(describeStep({ type: "send_dtmf", digits: "12#" }), 'Send DTMF "12#"');
  });

  it("normalizeTargets validates flow_id and from_numbers per target", () => {
    const targets = normalizeTargets({
      targets: [
        { flow_id: "flow-1", total_calls: 10, from_numbers: ["+48123", "+48456"], action_id: "a1" },
        { flow_id: "", total_calls: 5, from_numbers: ["+48123"] }, // dropped: no flow
        { flow_id: "flow-2", total_calls: 3, from_numbers: [] }, // dropped: no numbers
      ],
    });
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(targets[0].flow_id, "flow-1");
    assert.strictEqual(targets[0].action_id, "a1");
  });

  it("normalizeTargets clamps total_calls and falls back to legacy config", () => {
    const clamped = normalizeTargets({ targets: [{ flow_id: "f", total_calls: 99999, from_numbers: ["+1"] }] });
    assert.strictEqual(clamped[0].total_calls, 1000);
    const legacy = normalizeTargets({ target_type: "call_flow", target: "legacy-flow", total_calls: 7, from_numbers: ["+1"] });
    assert.strictEqual(legacy.length, 1);
    assert.strictEqual(legacy[0].flow_id, "legacy-flow");
    assert.strictEqual(legacy[0].total_calls, 7);
    const legacyWithGlobalNumbers = normalizeTargets(
      { target_type: "call_flow", target: "legacy-flow", total_calls: 2 },
      ["+15550001111"],
    );
    assert.deepStrictEqual(legacyWithGlobalNumbers[0].from_numbers, ["+15550001111"]);
    assert.deepStrictEqual(normalizeTargets({}), []);
  });

  it("schema defines cg_actions with steps JSONB", async () => {
    const code = await src("lib/postgres-schema.mjs");
    assert.match(code, /CREATE TABLE IF NOT EXISTS cg_actions/);
    assert.match(code, /cg_actions_updated_at_trigger/);
  });

  it("actions API supports list/create and update/delete", async () => {
    const listCode = await src("app/api/admin/call-generator/actions/route.js");
    assert.match(listCode, /export async function GET/);
    assert.match(listCode, /export async function POST/);
    assert.match(listCode, /normalizeSteps/);
    const itemCode = await src("app/api/admin/call-generator/actions/[id]/route.js");
    assert.match(itemCode, /export async function PUT/);
    assert.match(itemCode, /export async function DELETE/);
    assert.match(itemCode, /const \{ id \} = await params/);
    assert.doesNotMatch(itemCode, /params\.id/);
  });

  it("resources API returns flows, audio media and actions", async () => {
    const code = await src("app/api/admin/call-generator/resources/route.js");
    assert.match(code, /voice_flows/);
    assert.match(code, /\/media/);
    assert.match(code, /cg_actions/);
    assert.match(code, /audio/i);
  });

  it("runner seeds ledger rows per target with rotated from_number and action steps", async () => {
    const code = await src("lib/call-generator/runner.mjs");
    assert.match(code, /normalizeTargets/);
    assert.match(code, /i % target\.from_numbers\.length/);
    assert.match(code, /action_steps/);
    assert.match(code, /from_numbers_not_enabled/);
    assert.match(code, /no_valid_targets/);
  });

  it("engine executes action step sequences on answer", async () => {
    const code = await src("lib/call-generator/engine.mjs");
    assert.match(code, /action_steps/);
    assert.match(code, /playback_start/);
    assert.match(code, /send_dtmf/);
    assert.match(code, /speak/);
  });

  it("page uses 3-panel layout with Actions section, flow select and validation gating", async () => {
    const code = await src("app/(portal)/admin/call-generator/page.jsx");
    assert.match(code, /Context settings/);
    assert.match(code, /Target Flow/);
    assert.match(code, /Add target/);
    assert.match(code, /scenarioTargetsValid/);
    assert.match(code, /disabled=\{!valid \|\| saving\}/);
    assert.match(code, /VoiceSelector/);
    assert.match(code, /Media Library/);
    assert.match(code, /send_dtmf/);
    assert.match(code, /rotate through selected numbers round-robin/i);
  });

  it("scenario save is gated on required fields (name, flow, calls>=1, numbers>=1)", async () => {
    const code = await src("app/(portal)/admin/call-generator/page.jsx");
    assert.match(code, /Number\(t\.total_calls\) >= 1/);
    assert.match(code, /t\.from_numbers\.length >= 1/);
    assert.match(code, /String\(t\.flow_id \|\| ""\)\.trim\(\)/);
  });
});

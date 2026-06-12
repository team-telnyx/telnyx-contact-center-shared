import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { normalizeSteps, describeStep } from "../lib/call-generator/actions.mjs";
import { normalizeTargets } from "../lib/call-generator/runner.mjs";
import { analyzeFlowForWorkflowTesting } from "../lib/call-generator/workflow-testing.mjs";

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
        { flow_id: "flow-1", total_calls: 10, from_numbers: ["+48123", "+48456"], action_id: "a1", action_trigger: "agent_bridge" },
        { flow_id: "", total_calls: 5, from_numbers: ["+48123"] }, // dropped: no flow
        { flow_id: "flow-2", total_calls: 3, from_numbers: [] }, // dropped: no numbers
      ],
    });
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(targets[0].flow_id, "flow-1");
    assert.strictEqual(targets[0].action_id, "a1");
    assert.strictEqual(targets[0].action_trigger, "agent_bridge");
  });

  it("normalizeTargets clamps total_calls and falls back to legacy config", () => {
    const clamped = normalizeTargets({ targets: [{ flow_id: "f", total_calls: 99999, from_numbers: ["+1"] }] });
    assert.strictEqual(clamped[0].total_calls, 1000);
    assert.strictEqual(clamped[0].action_trigger, "call_answer");
    const legacy = normalizeTargets({ target_type: "call_flow", target: "legacy-flow", total_calls: 7, from_numbers: ["+1"] });
    assert.strictEqual(legacy.length, 1);
    assert.strictEqual(legacy[0].flow_id, "legacy-flow");
    assert.strictEqual(legacy[0].total_calls, 7);
    assert.strictEqual(legacy[0].action_trigger, "call_answer");
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
    assert.match(code, /action_trigger/);
    assert.match(code, /agent_bridge/);
    assert.match(code, /from_numbers_not_enabled/);
    assert.match(code, /no_valid_targets/);
  });

  it("engine executes action step sequences on answer", async () => {
    const code = await src("lib/call-generator/engine.mjs");
    assert.match(code, /action_steps/);
    assert.match(code, /shouldRunActionTrigger/);
    assert.match(code, /case "call\.bridged"/);
    assert.match(code, /executeSequence/);
    assert.match(code, /action_sequence_started_at/);
    assert.match(code, /playback_start/);
    assert.match(code, /send_dtmf/);
    assert.match(code, /speak/);
  });

  it("page uses 3-panel layout with Actions section, flow select and validation gating", async () => {
    const code = await src("app/(portal)/admin/call-generator/page.jsx");
    assert.match(code, /Context settings/);
    assert.match(code, /Target Flow/);
    assert.match(code, /Run actions on/);
    assert.match(code, /role="radiogroup" aria-label="Run actions on"/);
    assert.match(code, /role="radio"/);
    assert.match(code, /aria-checked=\{activeTrigger\}/);
    assert.match(code, /Call Answer/);
    assert.match(code, /Agent Bridge/);
    assert.match(code, /Start immediately when the flow answers/);
    assert.match(code, /Wait until the caller is bridged to an agent/);
    assert.match(code, /Add target/);
    assert.match(code, /scenarioTargetsValid/);
    assert.match(code, /disabled=\{!valid \|\| saving\}/);
    assert.match(code, /VoiceSelector/);
    assert.match(code, /Media Library/);
    assert.match(code, /send_dtmf/);
    assert.match(code, /rotate through selected numbers round-robin/i);
  });

  it("scenario save is gated on required fields (name, flow, calls>=1, numbers>=1, action)", async () => {
    const code = await src("app/(portal)/admin/call-generator/page.jsx");
    assert.match(code, /Number\(t\.total_calls\) >= 1/);
    assert.match(code, /t\.from_numbers\.length >= 1/);
    assert.match(code, /String\(t\.flow_id \|\| ""\)\.trim\(\)/);
    assert.match(code, /String\(t\.action_id \|\| ""\)\.trim\(\)/);
  });

  it("page has no env-flag references — settings switch is the only gate", async () => {
    const code = await src("app/(portal)/admin/call-generator/page.jsx");
    assert.doesNotMatch(code, /CALL_GENERATOR/);
    assert.match(code, /Master switch/);
  });

  it("settings summary uses dialer-style tiles and telnyx green number badges", async () => {
    const code = await src("app/(portal)/admin/call-generator/page.jsx");
    assert.match(code, /toneClasses/);
    assert.match(code, /telnyxNumberBadgeClass/);
    assert.match(code, /#00E58F/);
    assert.match(code, /showBadges=\{false\}/);
  });

  it("actions editor renders preview play buttons for speak and media steps", async () => {
    const code = await src("app/(portal)/admin/call-generator/page.jsx");
    assert.match(code, /useAudioPreview/);
    assert.match(code, /PreviewButton/);
    assert.match(code, /MediaFileSelector/);
    assert.match(code, /\/api\/tts\/speech/);
    assert.match(code, /media-library\/\$\{encodeURIComponent\(value\)\}\/stream/);
    assert.match(code, /previewText=\{step\.text \|\| ""\}/);
  });

  it("voice dropdown sits on its own row with the preview button beside it", async () => {
    const code = await src("app/(portal)/admin/call-generator/page.jsx");
    // provider+model share a 2-col row; voice select moved to a separate flex row
    assert.match(code, /grid grid-cols-2 gap-2/);
    assert.match(code, /IconPlayerStop/);
    // triggers must be w-full min-w-0 so provider/model fill 50% each and
    // voice/media stretch up to the Play button without overflowing the card
    assert.match(code, /<SelectTrigger className="w-full min-w-0"><SelectValue placeholder=\{voicesLoading \? "Loading…" : "Provider"\} \/>/);
    assert.match(code, /<SelectTrigger className="w-full min-w-0"><SelectValue placeholder=\{voicesLoading \? "Loading…" : "Model"\} \/>/);
    assert.match(code, /<SelectTrigger className="w-full min-w-0"><SelectValue placeholder=\{voicesLoading \? "Loading voices…" : "Voice"\} \/>/);
    assert.match(code, /<SelectTrigger className="w-full"><SelectValue placeholder="Select from Media Library" \/>/);
  });

  it("voice selector hides raw voice IDs while the voice list is loading", async () => {
    const code = await src("app/(portal)/admin/call-generator/page.jsx");
    assert.match(code, /voicesLoading/);
    // value is blanked during load so the fallback raw-ID item never renders
    assert.match(code, /value=\{voicesLoading \? "" : current\}/);
    assert.match(code, /!voicesLoading && !voices\.length && current/);
    assert.match(code, /disabled=\{voicesLoading\}/);
  });

  it("workflow testing action is protected, seeded, and configurable by voice and preview sample text", async () => {
    const steps = normalizeSteps([{ type: "workflow_testing", voice: "MiniMax.Customer", sample_text: "Cześć, sprawdzam ten głos po polsku." }]);
    assert.deepStrictEqual(steps, [{ type: "workflow_testing", voice: "MiniMax.Customer", sample_text: "Cześć, sprawdzam ten głos po polsku." }]);
    assert.match(describeStep(steps[0]), /Workflow Testing/);
    const workflowTesting = await src("lib/call-generator/workflow-testing.mjs");
    assert.match(workflowTesting, /DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT/);
    assert.match(workflowTesting, /This is a neutral voice preview for workflow testing\./);
    assert.doesNotMatch(workflowTesting, /medical transport/i);
    const schema = await src("lib/postgres-schema.mjs");
    assert.match(schema, /ensureWorkflowTestingAction/);
    const actionsApi = await src("app/api/admin/call-generator/actions/[id]/route.js");
    assert.match(actionsApi, /WORKFLOW_TESTING_ACTION_ID/);
    assert.match(actionsApi, /sample_text/);
    assert.match(actionsApi, /protected system action and cannot be deleted/);
  });

  it("protected workflow testing action editor exposes TTS voice and editable preview text", async () => {
    const page = await src("app/(portal)/admin/call-generator/page.jsx");
    assert.match(page, /const protectedWorkflowTesting = actionId === WORKFLOW_TESTING_ACTION_ID/);
    assert.match(page, /Only the caller simulation TTS voice and preview sample text can be changed here/);
    assert.match(page, /protectedWorkflowTesting \? null : <div className="grid grid-cols-3 gap-2">/);
    assert.match(page, /Caller simulation voice/);
    assert.match(page, /Preview sample text/);
    assert.match(page, /value=\{step\.sample_text \|\| DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT\}/);
    assert.match(page, /previewText=\{step\.sample_text \|\| DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT\}/);
    assert.doesNotMatch(page, /medical transport/i);
    assert.match(page, /protectedWorkflowTesting \? null : <div className="flex items-center gap-1">/);
  });

  it("scenario action controls are hidden while Test Workflow is active", async () => {
    const page = await src("app/(portal)/admin/call-generator/page.jsx");
    assert.match(page, /const selectableActions = actions\.filter\(\(a\) => a\.id !== WORKFLOW_TESTING_ACTION_ID\)/);
    assert.match(page, /selectableActions\.map\(\(a\) => <SelectItem key=\{a\.id\} value=\{a\.id\}>\{a\.name\}<\/SelectItem>\)/);
    assert.match(page, new RegExp(String.raw`target\.workflow_testing !== true \? \(\s*<>[\s\S]*Action sequence[\s\S]*Run actions on[\s\S]*<\/>\s*\) : null`));
    assert.doesNotMatch(page, /Disabled while Test Workflow is active/);
    assert.doesNotMatch(page, /Action sequence is disabled because Test Workflow/);
  });

  it("workflow testing target bypasses manual action sequence and validates transcription", () => {
    const targets = normalizeTargets({ targets: [{ flow_id: "flow-1", total_calls: 1, from_numbers: ["+48123"], workflow_testing: true, workflow_id: "wf-1", workflow_name: "Healthcare Intake", transcription_active: true }] });
    assert.strictEqual(targets[0].workflow_testing, true);
    assert.strictEqual(targets[0].workflow_id, "wf-1");
    assert.strictEqual(targets[0].action_id, "00000000-0000-4000-8000-000000000001");
  });

  it("resources and UI expose workflow readiness, workflow name, and transcription gating", async () => {
    const resources = await src("app/api/admin/call-generator/resources/route.js");
    assert.match(resources, /aa_workflows/);
    assert.match(resources, /analyzeFlowForWorkflowTesting/);
    const page = await src("app/(portal)/admin/call-generator/page.jsx");
    assert.match(page, /Test Workflow/);
    assert.match(page, /LLM caller simulator will test workflow/);
    assert.match(page, /transcription is not active/);
    assert.match(page, /target\.workflow_testing !== true \? \(/);
  });

  it("workflow testing analysis reads React Flow data.nodeType before customNode type", () => {
    const analysis = analyzeFlowForWorkflowTesting({
      nodes: [
        { type: "customNode", data: { nodeType: "answer", config: { transcription_enabled: true } } },
        { type: "customNode", data: { nodeType: "agent_assist", config: { enabled: true, assist_type: "workflows", workflow_id: "wf-1" } } },
      ],
    }, { "wf-1": { name: "Healthcare Intake" } });
    assert.strictEqual(analysis.capable, true);
    assert.strictEqual(analysis.enabled, true);
    assert.strictEqual(analysis.workflow_id, "wf-1");
    assert.strictEqual(analysis.workflow_name, "Healthcare Intake");
  });

  it("finalized agent transcription triggers dynamic workflow-testing caller replies", async () => {
    const router = await src("lib/agent-assist-transcription-router.mjs");
    assert.match(router, /metadata->>'original_call_control_id' = \$1/);
    assert.match(router, /metadata->>'agent_call_control_id' = \$1/);
    assert.match(router, /handleWorkflowTestingFinalTranscription/);
    assert.match(router, /workflow_testing_transcription_reply_failed/);
    const contactCenterWebhook = await src("lib/contact-center/webhook-handler.js");
    assert.match(contactCenterWebhook, /handleWorkflowTestingFinalTranscription/);
    assert.match(contactCenterWebhook, /routedTranscriptionData/);
    assert.match(contactCenterWebhook, /workflow_testing_transcription_reply_failed/);
    const sttHandler = await src("lib/telnyx-stt-handler.mjs");
    assert.match(sttHandler, /this\.interactionId = this\.clientState\.interaction_id \|\| this\.clientState\.interactionId \|\| null/);
    const workflowTesting = await src("lib/call-generator/workflow-testing.mjs");
    assert.match(workflowTesting, /latest_agent_transcript/);
    assert.match(workflowTesting, /actions\/speak/);
    assert.match(workflowTesting, /aa_workflows/);
  });

  it("runner persists workflow testing metadata and rejects missing transcription", async () => {
    const code = await src("lib/call-generator/runner.mjs");
    assert.match(code, /workflow_testing_transcription_required/);
    assert.match(code, /workflow_testing_workflow_required/);
    assert.match(code, /workflowTestingVoiceFromAction/);
    assert.match(code, /workflow_testing/);
  });
});

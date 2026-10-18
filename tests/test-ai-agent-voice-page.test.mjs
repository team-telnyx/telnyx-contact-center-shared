import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guards for the AI Agent voice test transport.
//
// The voice channel of "Test AI Agent" runs over the authenticated Telnyx
// conversation WebSocket (the assistant call relay), not over the anonymous
// WebRTC SDK. The old harness patched navigator.mediaDevices.getUserMedia,
// fed a synthetic microphone stream and guessed turn boundaries from output
// loudness ("turn settle", "welcome gate"); none of that may come back.
//

const SRC_URL = new URL("../app/(portal)/admin/workflows/[id]/test/page.jsx", import.meta.url);

test("the voice test uses the authenticated conversation WebSocket client and relay", async () => {
  const src = await readFile(SRC_URL, "utf8");
  assert.match(src, /from "@\/lib\/ai\/telnyx-avatar-client\.mjs"/, "page should import TelnyxAvatarClient");
  assert.match(src, /from "@\/lib\/ai\/workflow-voice-test-engine\.mjs"/, "page should import the turn engine");
  assert.match(src, /\/voice-test-session`/, "page should request a workflow-scoped call session");
  assert.match(src, /client\.on\("assistant\.event"/, "page should consume the raw Telnyx events");
  assert.match(src, /capture: currentAutoMode \? "none" : "microphone"/, "AUTO mode must not capture the microphone");
});

test("no anonymous WebRTC, synthetic microphone or loudness heuristics remain", async () => {
  const src = await readFile(SRC_URL, "utf8");
  assert.doesNotMatch(src, /@telnyx\/ai-agent-lib/, "the anonymous WebRTC SDK must not be used by the test page");
  assert.doesNotMatch(src, /getUserMedia\s*=/, "navigator.mediaDevices.getUserMedia must not be patched");
  assert.doesNotMatch(src, /MockMicrophone/, "the synthetic microphone must not be reintroduced");
  assert.doesNotMatch(src, /turnSettle|welcomeMessageReceivedRef|voiceResponseDelay/, "turn boundaries come from Telnyx events, not timers");
});

test("the caller turn is opened by response.done through the engine and audio is paced", async () => {
  const src = await readFile(SRC_URL, "utf8");
  assert.match(src, /case "caller_turn":\s*\n\s*void runCallerTurn\(action\.text\);/, "caller_turn action should drive the simulated caller");
  assert.match(src, /createPacedSender\(frames, \{ send: \(frame\) => client\.appendInputAudio\(frame\) \}\)/, "TTS audio must be paced into appendInputAudio");
  assert.match(src, /armResponseWatchdog\(/, "a watchdog must cover an assistant that never answers");
});

test("Codex review on #1636: watchdog token, ending, text echoes and channel lock", async () => {
  const src = await readFile(SRC_URL, "utf8");
  // A watchdog armed after the audio finished never fires for a line that was
  // heard (user_final) or answered (assistant_started) meanwhile.
  assert.match(src, /const token = \+\+callerUtteranceRef\.current;/);
  assert.match(src, /return \{ \.\.\.\(await sender\.done\), token \};/);
  assert.match(src, /if \(lineToken !== callerUtteranceRef\.current\) return;/);
  assert.match(src, /case "assistant_started":\s*\n\s*callerUtteranceRef\.current \+= 1;/);
  assert.equal((src.match(/armResponseWatchdog\([^)]*result\.token\)/g) || []).length, 2, "every armed watchdog carries its line token");
  // A closing phrase finishes the test after a grace period; a failed response stops it.
  assert.match(src, /case "ending":[\s\S]{0,600}endingTimerRef\.current = setTimeout\([\s\S]{0,200}finishVoiceTest\(\);[\s\S]{0,40}VOICE_ENDING_GRACE_MS\)/);
  assert.match(src, /case "response_failed":\s*\n\s*finishVoiceTest\(/);
  // MANUAL text echoes are matched by text, not by "skip the next transcription".
  assert.doesNotMatch(src, /lastSpokenLocalRef/);
  assert.match(src, /echo\.text === normalizeEchoText\(action\.text\)/);
  // The channel cannot change during a test, and a voice conversation id is never used for REST chat.
  assert.match(src, /<TabsTrigger value="chat" disabled=\{isTestRunning\}>/);
  assert.match(src, /<TabsTrigger value="voice" disabled=\{isTestRunning\}>/);
  assert.match(src, /channel === "chat" && conversationId && !voiceClientRef\.current/);
});

test("voice-test-session reports a deleted assistant as 404 (Telnyx status in providerStatus)", async () => {
  const { loadRoute } = await import("./helpers/route-harness.mjs");
  const route = await loadRoute("app/api/admin/workflows/[id]/voice-test-session/route.js", {
    "@/lib/authz/guard": { withPermission: (_permission, handler) => (request, context) => handler(request, context, { user: { id: 7, authSessionId: null } }) },
    "@/lib/postgres.mjs": { getPostgresPool: () => ({ query: async () => ({ rows: [{ id: "wf-1", name: "Workflow", ai_assistant_id: "assistant-gone" }] }) }) },
    "@/lib/widgets/ai-provider": { widgetAiRequest: async () => { throw Object.assign(new Error("Telnyx AI request failed"), { status: 502, providerStatus: 404 }); } },
    "@/lib/ai/assistant-call-session.mjs": { assistantCallSocketUrl: () => "ws://local/assistant-call", issueAssistantCallSession: () => "token", WORKFLOW_TEST_SCOPE: "workflow-test" },
    env: {},
  });
  const request = new Request("http://local/api/admin/workflows/wf-1/voice-test-session", { method: "POST", headers: { origin: "http://local" } });
  const response = await route.POST(request, { params: Promise.resolve({ id: "wf-1" }) });
  assert.equal(response.status, 404);
  assert.match(response.body.error, /no longer exists in Telnyx/);
});

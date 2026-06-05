import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

function between(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing start needle: ${startNeedle}`);
  const end = src.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing end needle: ${endNeedle}`);
  return src.slice(start, end);
}

test("direct route-call assignment marks ringing agent Busy before UI broadcast", async () => {
  const src = await source("app/api/contact-center/routing/route-call/route.js");
  const assignmentBlock = between(
    src,
    "if (routingResult.success && routingResult.agent) {",
    "// Broadcast routing event via SSE",
  );
  assert.match(assignmentBlock, /handleAgentCallLifecycleStatus\([\s\S]*event:\s*"ringing"/);
  assert.ok(
    assignmentBlock.indexOf("await promoteReservation") < assignmentBlock.indexOf("await handleAgentCallLifecycleStatus"),
    "reservation should be promoted before Busy transition",
  );
  assert.ok(
    assignmentBlock.indexOf("await handleAgentCallLifecycleStatus") < assignmentBlock.indexOf("assignCallToAgent"),
    "server-authoritative Busy must happen before local cache/UI broadcast",
  );
});

test("pre-answer agent-leg hangup always requeues instead of depending on exact ringing state", async () => {
  const src = await source("lib/contact-center/webhook-handler.js");
  const predicate = between(
    src,
    "const isAgentLegNoAnswerDisconnect =",
    "if (isAgentLegNoAnswerDisconnect)",
  );
  assert.match(predicate, /isAgentLegHangup/);
  assert.match(predicate, /original_call_control_id/);
  assert.match(predicate, /!latestInteraction\.answered_at/);
  assert.doesNotMatch(predicate, /latestInteraction\.state\s*===\s*["']ringing["']/);
});

test("agent-leg disconnect may hang up original caller leg only after answered_at", async () => {
  const src = await source("lib/contact-center/webhook-handler.js");
  const branch = between(
    src,
    "if (\n        isAgentLegHangup &&",
    "} else if (isAgentLegHangup && hasConsultState)",
  );
  assert.match(branch, /latestInteraction\.answered_at/);
  assert.match(branch, /Hanging up original call leg/);
});

test("agent active-calls API hides pre-answer ghosts while agent is Agent Not Answering", async () => {
  const src = await source("app/api/contact-center/agents/[userId]/calls/route.js");
  assert.match(src, /LEFT JOIN cc_agent_state ast ON ast\.user_id = u\.id/);
  assert.match(src, /LEFT JOIN cc_agent_state agent_state ON agent_state\.user_id = agent_user\.id/);
  assert.match(src, /COALESCE\(agent_state\.agent_status, ''\) <> 'Agent Not Answering'/);
  assert.doesNotMatch(src, /agent_user\.agent_status|\bagent_status, max_concurrent_calls\s+FROM users/i);
});

test("softphone reject immediately clears local call state and refreshes desktop", async () => {
  const src = await source("components/softphone-mini.jsx");
  const reject = between(src, "async function handleRejectCall()", "function hangup() {");
  assert.match(reject, /rejectedBeforeAnswer:\s*true/);
  assert.match(reject, /wasAnswered:\s*false/);
  assert.match(reject, /clearActiveCall\(\)/);
  assert.match(reject, /contact-center:refresh-interactions/);
  assert.doesNotMatch(reject, /originalCallControlId[^\n]+hangup/);
});

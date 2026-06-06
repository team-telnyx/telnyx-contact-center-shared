import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const softphoneMiniPath = new URL("../components/softphone-mini.jsx", import.meta.url);
const softphonePath = new URL("../components/softphone.jsx", import.meta.url);
const timeoutPath = new URL("../lib/contact-center/agent-answer-timeout.js", import.meta.url);
const wrapupRoutePath = new URL("../app/api/contact-center/interactions/[id]/wrapup/route.js", import.meta.url);
const globalWrapupPath = new URL("../components/contact-center/GlobalWrapupSheet.jsx", import.meta.url);
const agentDesktopPath = new URL("../components/contact-center/AgentDesktop.jsx", import.meta.url);
const stateManagerPath = new URL("../lib/contact-center/state-manager.js", import.meta.url);
const webhookHandlerPath = new URL("../lib/contact-center/webhook-handler.js", import.meta.url);

async function source(url) {
  return readFile(url, "utf8");
}

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start === -1) throw new Error(`Missing function ${name}`);
  let depth = 0;
  let bodyStart = -1;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === "{") {
      depth += 1;
      if (bodyStart === -1) bodyStart = i;
    } else if (src[i] === "}") {
      depth -= 1;
      if (bodyStart !== -1 && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

test("softphone reject for queued inbound calls never hangs up the original caller leg", async () => {
  for (const url of [softphoneMiniPath, softphonePath]) {
    const src = await source(url);
    const rejectFn = extractFunction(src, "handleRejectCall");

    assert.match(rejectFn, /activeCall\.hangup\?\.\(\)/, "reject should hang up only the WebRTC agent leg");
    assert.doesNotMatch(rejectFn, /originalCallControlId/);
    assert.doesNotMatch(rejectFn, /\/api\/voice\/call-action/);
    assert.doesNotMatch(rejectFn, /\/interactions\/\$\{[^}]+\}\/hangup/);
    assert.match(rejectFn, /rejectedBeforeAnswer:\s*true/);
    assert.match(rejectFn, /wasAnswered:\s*false/);
  }
});

test("no-answer requeue must never fall back to hanging up the original caller leg", async () => {
  const src = await source(timeoutPath);
  const hangupAgentLeg = extractFunction(src, "hangupAgentLeg");

  assert.match(hangupAgentLeg, /agentCallControlId/);
  assert.doesNotMatch(hangupAgentLeg, /originalCallControlId/);
  assert.doesNotMatch(hangupAgentLeg, /metadata, call_control_id: originalCallControlId/);
  assert.match(hangupAgentLeg, /agent_leg_call_control_id_missing_for_timeout_hangup/);
});

test("wrapup can only start for interactions that were actually answered", async () => {
  const src = await source(wrapupRoutePath);

  assert.match(src, /const wasAnswered\s*=\s*Boolean\(interaction\.answered_at\)/);
  assert.match(src, /Wrapup requires an answered call/);
  assert.match(src, /status:\s*409/);
  assert.ok(
    src.indexOf("const wasAnswered") < src.indexOf('if (action === "start")'),
    "answered guard must be established before action=start wrapup logic",
  );
});

test("global wrapup UI defaults to no wrapup unless answered evidence exists", async () => {
  const src = await source(globalWrapupPath);

  assert.doesNotMatch(src, /Default to opening wrapup sheet only if not timeout/);
  assert.match(src, /No interaction evidence; not opening wrapup/);
  assert.match(src, /const wasAnswered =/);
  assert.match(src, /if \(!wasAnswered\) \{/);
});

test("agent desktop ignores pre-answer reject disconnects instead of opening wrapup", async () => {
  const src = await source(agentDesktopPath);

  assert.match(src, /rejectedBeforeAnswer\s*=\s*false/);
  assert.match(src, /wasAnswered/);
  assert.match(src, /if \(rejectedBeforeAnswer \|\| wasAnswered === false\) \{/);
  assert.doesNotMatch(src, /wasAnswered !== true/);
  assert.match(src, /preserve the normal\s+\/\/ answered-call fallback/);
});

test("state-manager does not locally derive Agent Not Answering from generic call completion", async () => {
  const src = await source(stateManagerPath);
  const completeCall = src.slice(
    src.indexOf("function completeCall"),
    src.indexOf("/**\n * Update agent status"),
  );

  assert.match(src, /options = \{\}/);
  assert.match(src, /const failedRinging = Boolean\(options\.failedRinging\)/);
  assert.doesNotMatch(
    completeCall,
    /agentState\.agentStatus\s*=\s*"Available"|agentState\.agentStatus\s*=\s*"Agent Not Answering"/,
    "completeCall is read-model/statistics only; authoritative status transitions happen through DB writers",
  );
});

test("webhook passes failed-ringing context only for reject or no-answer hangups", async () => {
  const src = await source(webhookHandlerPath);

  assert.match(src, /const failedRinging =/);
  assert.match(src, /hangup_cause === "CALL_REJECTED"/);
  assert.match(src, /hangup_cause === "NO_ANSWER"/);
  assert.match(src, /payload\?\.hangup_cause === "CALL_REJECTED"/);
  assert.match(src, /payload\?\.hangup_cause === "NO_ANSWER"/);
  assert.match(src, /completeCall\(interaction\.id, completedAt, wasAbandoned, \{ failedRinging \}\)/);
});

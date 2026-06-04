import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const softphoneMiniPath = new URL("../components/softphone-mini.jsx", import.meta.url);
const softphonePath = new URL("../components/softphone.jsx", import.meta.url);
const timeoutPath = new URL("../lib/contact-center/agent-answer-timeout.js", import.meta.url);
const wrapupRoutePath = new URL("../app/api/contact-center/interactions/[id]/wrapup/route.js", import.meta.url);
const globalWrapupPath = new URL("../components/contact-center/GlobalWrapupSheet.jsx", import.meta.url);
const stateManagerPath = new URL("../lib/contact-center/state-manager.js", import.meta.url);

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
  assert.match(hangupAgentLeg, /No agent leg call control ID/);
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

test("state-manager does not auto-Available abandoned pre-answer calls", async () => {
  const src = await source(stateManagerPath);
  const completeCall = extractFunction(src, "completeCall");

  assert.match(completeCall, /Agent Not Answering/);
  assert.doesNotMatch(completeCall, /agentState\.agentStatus\s*=\s*"Available";\s*\/\/ Set available_since when agent becomes fully available/s);
});

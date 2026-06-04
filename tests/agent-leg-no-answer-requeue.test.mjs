import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(path) {
  return readFile(path, "utf8");
}

test("agent leg hangup before answer re-enqueues instead of hanging up caller", async () => {
  const webhookSrc = await source(
    new URL("../lib/contact-center/webhook-handler.js", import.meta.url),
  );

  assert.match(
    webhookSrc,
    /handleAgentLegNoAnswerDisconnect/,
    "webhook handler must use the no-answer requeue path for pre-answer agent leg disconnects",
  );

  const noAnswerBlock = webhookSrc.slice(
    webhookSrc.indexOf("const isAgentLegNoAnswerDisconnect"),
    webhookSrc.indexOf("if (\n        isAgentLegHangup &&"),
  );

  assert.match(noAnswerBlock, /isAgentLegHangup/);
  assert.doesNotMatch(
    noAnswerBlock,
    /latestInteraction\.state === "ringing"/,
    "pre-answer agent-leg disconnect must requeue even if interaction state is stale/racy",
  );
  assert.match(noAnswerBlock, /!latestInteraction\.answered_at/);
  assert.match(noAnswerBlock, /const wasReEnqueued = await handleAgentLegNoAnswerDisconnect/);
  assert.match(noAnswerBlock, /if \(wasReEnqueued\) \{/);
  assert.match(
    noAnswerBlock,
    /findInteractionById\(\s*latestInteraction\.id,?\s*\)/,
    "stale agent-leg hangups must re-check interaction state before normal cleanup",
  );
  assert.match(
    noAnswerBlock,
    /latestInteraction\.state !== "ringing"/,
    "stale agent-leg hangups for already requeued callers must not abandon the interaction",
  );
  assert.match(noAnswerBlock, /continuing with normal hangup cleanup/);

  const originalHangupIndex = webhookSrc.indexOf("Hanging up original call leg");
  const noAnswerIndex = webhookSrc.indexOf("const isAgentLegNoAnswerDisconnect");
  assert.ok(
    noAnswerIndex > -1 && originalHangupIndex > -1 && noAnswerIndex < originalHangupIndex,
    "no-answer requeue guard must run before original caller leg hangup",
  );
});

test("agent-answer-timeout exports immediate no-answer handler", async () => {
  const timeoutSrc = await source(
    new URL("../lib/contact-center/agent-answer-timeout.js", import.meta.url),
  );

  assert.match(timeoutSrc, /export async function handleAgentLegNoAnswerDisconnect/);
  assert.match(timeoutSrc, /return handleTimeoutForInteraction\(hydratedInteraction\)/);
  assert.match(timeoutSrc, /return false/);
  assert.match(timeoutSrc, /return true/);
  assert.match(timeoutSrc, /agent_answer_timeout_secs/);
});

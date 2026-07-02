import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  helper: "lib/contact-center/logging.mjs",
  queueActivate: "app/api/contact-center/agent/queues/activate/route.js",
  queueDeactivate: "app/api/contact-center/agent/queues/deactivate/route.js",
  queueAgents: "app/api/contact-center/queues/[queueId]/agents/route.js",
  queueCalls: "app/api/contact-center/queues/[queueId]/calls/route.js",
  queueList: "app/api/contact-center/queues/list/route.js",
  speakQueue: "lib/contact-center/speak-queue.js",
  skillsReEvaluator: "lib/contact-center/skills-re-evaluator.js",
  waitingReasonReEvaluator: "lib/contact-center/waiting-reason-re-evaluator.js",
  webhookHandler: "lib/contact-center/webhook-handler.js",
  webrtcBridge: "lib/contact-center/webrtc-bridge.js",
};

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const forbiddenLegacyDiagnostics = /console\.(log|warn|error|info|debug)|[`"]\[[A-Za-z0-9][^`"]*\]|_legacy_/;
const forbiddenRawPayloadKeys = /\b(rawPayload|webhookPayload|eventPayload|fullPayload|requestBody|bodyText)\b/;

test("Contact Center helper exposes canonical queue/runtime loggers for remaining operational slice", async () => {
  const helper = await source(files.helper);

  assert.match(helper, /export const queuesLogger = createDiagnosticLogger\("contact-center\.queues"\)/);
  assert.match(helper, /export const webrtcBridgeLogger = createDiagnosticLogger\("contact-center\.interactions"\)/);
});

test("Contact Center queue routes use queuesLogger without legacy console diagnostics", async () => {
  for (const path of [files.queueActivate, files.queueDeactivate, files.queueAgents, files.queueCalls, files.queueList]) {
    const content = await source(path);
    assert.match(content, /contact-center\/logging\.mjs/, `${path} must import Contact Center logging helper`);
    assert.match(content, /queuesLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/, `${path} must emit structured queue events`);
    assert.doesNotMatch(content, forbiddenLegacyDiagnostics, `${path} still contains legacy console/bracket diagnostics`);
  }
});

test("Remaining Contact Center runtime libs use shared helper loggers without legacy diagnostics", async () => {
  const expectations = [
    [files.speakQueue, /queuesLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.skillsReEvaluator, /routingLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.waitingReasonReEvaluator, /routingLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.webhookHandler, /interactionsLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.webrtcBridge, /webrtcBridgeLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
  ];

  for (const [path, loggerPattern] of expectations) {
    const content = await source(path);
    assert.match(content, /contact-center\/logging\.mjs|\.\/logging\.mjs/, `${path} must import Contact Center logging helper`);
    assert.match(content, loggerPattern, `${path} must use the expected shared logger`);
    assert.doesNotMatch(content, forbiddenLegacyDiagnostics, `${path} still contains legacy console/bracket diagnostics`);
  }
});

test("Remaining Contact Center runtime logs keep compact triage fields and avoid raw sensitive payload keys", async () => {
  for (const path of Object.values(files)) {
    const content = await source(path);
    assert.doesNotMatch(content, forbiddenRawPayloadKeys, `${path} must not log raw/sensitive payload fields`);
  }

  const combined = await Promise.all(Object.values(files).map(source)).then((parts) => parts.join("\n"));
  for (const field of ["interactionId", "callControlId", "queueId", "agentUserId", "reason"]) {
    assert.match(combined, new RegExp(`\\b${field}\\b`), `expected safe field ${field} in remaining Contact Center logging slice`);
  }
});

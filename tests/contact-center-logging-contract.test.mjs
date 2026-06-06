import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  helper: "lib/contact-center/logging.mjs",
  routingEngine: "lib/contact-center/routing-engine.js",
  timeout: "lib/contact-center/agent-answer-timeout.js",
  reservations: "lib/contact-center/reservation-manager.js",
  agentStatus: "app/api/contact-center/agent/status/route.js",
  routingAgentStatus: "app/api/contact-center/routing/agent-status/route.js",
  routeCall: "app/api/contact-center/routing/route-call/route.js",
};

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function assertNoConsoleOrBracketPrefixes(path) {
  const src = await source(path);
  assert.doesNotMatch(src, /console\.(log|warn|error)\s*\(/, `${path} must use contact center pino logging, not console.*`);
  assert.doesNotMatch(src, /"\[[A-Za-z0-9][^\]"]+\]/, `${path} must not keep bracket-prefixed event strings`);
  assert.doesNotMatch(src, /`\[[A-Za-z0-9][^\]`]+\]/, `${path} must not keep bracket-prefixed template event strings`);
}

test("Contact Center logging helper exposes canonical topics and safe payload builders", async () => {
  const src = await source(files.helper);
  assert.match(src, /createDiagnosticLogger\("contact-center\.routing"/);
  assert.match(src, /createDiagnosticLogger\("contact-center\.timeout"/);
  assert.match(src, /createDiagnosticLogger\("contact-center\.reservations"/);
  assert.match(src, /createDiagnosticLogger\("contact-center\.status"/);
  assert.match(src, /export function createContactCenterLogger/);
  assert.match(src, /export function contactCenterErrorPayload/);
  assert.match(src, /export function callPayload/);
  assert.match(src, /export function agentPayload/);
  assert.doesNotMatch(src, /payload|rawPayload|webhookPayload|eventPayload|bodyText|requestBody/);

  const mod = await import("../lib/contact-center/logging.mjs");
  assert.equal(typeof mod.createContactCenterLogger, "function");
  assert.deepEqual(mod.callPayload({
    interactionId: "int-1",
    callControlId: "cc-1",
    callSessionId: "cs-1",
    payload: { secret: "must-not-appear" },
  }), {
    interactionId: "int-1",
    callControlId: "cc-1",
    callSessionId: "cs-1",
  });
  assert.deepEqual(mod.agentPayload({
    agentUserId: "user-1",
    agentUsername: "agent@example.com",
    extension: "101",
    token: "must-not-appear",
  }), {
    agentUserId: "user-1",
    agentUsername: "agent@example.com",
    extension: "101",
  });
  assert.deepEqual(mod.contactCenterErrorPayload(new Error("Boom")), {
    errorName: "Error",
    errorMessage: "Boom",
  });
});

test("PR1 P0 Contact Center files use canonical topics and no legacy console strings", async () => {
  for (const path of Object.values(files).filter((path) => path !== files.helper)) {
    await assertNoConsoleOrBracketPrefixes(path);
  }

  const routing = await source(files.routingEngine);
  assert.match(routing, /routingLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/);
  assert.match(routing, /\.\/logging\.mjs|contact-center\/logging/);

  const timeout = await source(files.timeout);
  assert.match(timeout, /timeoutLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/);

  const reservations = await source(files.reservations);
  assert.match(reservations, /reservationLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/);

  const agentStatus = await source(files.agentStatus);
  assert.match(agentStatus, /statusLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/);

  const routingAgentStatus = await source(files.routingAgentStatus);
  assert.match(routingAgentStatus, /statusLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/);

  const routeCall = await source(files.routeCall);
  assert.match(routeCall, /routingLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/);
});

test("Contact Center P0 logging helpers expose safe triage fields instead of full payload copies", async () => {
  const helper = await source(files.helper);
  assert.doesNotMatch(helper, /\b(rawPayload|webhookPayload|eventPayload|fullPayload|requestBody|bodyText)\b/);

  const combined = await Promise.all(Object.values(files).map(source)).then((parts) => parts.join("\n"));
  for (const field of ["interactionId", "callControlId", "callSessionId", "agentUserId", "queueId", "reason"]) {
    assert.match(combined, new RegExp(`\\b${field}\\b`), `expected safe field ${field} in PR1 logging`);
  }
});

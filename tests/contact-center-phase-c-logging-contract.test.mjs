import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  helper: "lib/contact-center/logging.mjs",
  answer: "app/api/contact-center/interactions/[id]/answer/route.js",
  wrapup: "app/api/contact-center/interactions/[id]/wrapup/route.js",
  timeoutCheck: "app/api/contact-center/interactions/[id]/timeout-check/route.js",
  transcription: "app/api/contact-center/interactions/[id]/transcription/route.js",
  consult: "app/api/contact-center/interactions/[id]/consult/route.js",
  consultByCallControl: "app/api/contact-center/interactions/by-call-control-id/consult/route.js",
  transfer: "app/api/contact-center/interactions/[id]/transfer/route.js",
  transferByCallControl: "app/api/contact-center/interactions/by-call-control-id/transfer/route.js",
  supervise: "app/api/contact-center/calls/supervise/route.js",
  switchSupervisorRole: "app/api/contact-center/calls/[callControlId]/switch-supervisor-role/route.js",
};

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const topicExpectations = [
  ["interactionsLogger", "contact-center.interactions"],
  ["wrapupLogger", "contact-center.wrapup"],
  ["consultLogger", "contact-center.consult"],
  ["transferLogger", "contact-center.transfer"],
  ["supervisionLogger", "contact-center.supervision"],
];

test("Phase C Contact Center logger helper exposes canonical operational topics", async () => {
  const helper = await source(files.helper);

  for (const [exportName, topic] of topicExpectations) {
    assert.match(helper, new RegExp(`export const ${exportName} = createDiagnosticLogger\\("${topic.replaceAll(".", "\\.")}"\\)`));
  }
});

test("Phase C route handlers use their canonical logger topics", async () => {
  const expectations = [
    [files.answer, /interactionsLogger/, /contact-center\/logging\.mjs/],
    [files.timeoutCheck, /interactionsLogger/, /contact-center\/logging\.mjs/],
    [files.transcription, /interactionsLogger/, /contact-center\/logging\.mjs/],
    [files.wrapup, /wrapupLogger/, /contact-center\/logging\.mjs/],
    [files.consult, /consultLogger/, /contact-center\/logging\.mjs/],
    [files.consultByCallControl, /consultLogger/, /contact-center\/logging\.mjs/],
    [files.transfer, /transferLogger/, /contact-center\/logging\.mjs/],
    [files.transferByCallControl, /transferLogger/, /contact-center\/logging\.mjs/],
    [files.supervise, /supervisionLogger/, /contact-center\/logging\.mjs/],
    [files.switchSupervisorRole, /supervisionLogger/, /contact-center\/logging\.mjs/],
  ];

  for (const [path, loggerPattern, importPattern] of expectations) {
    const content = await source(path);
    assert.match(content, importPattern, `${path} must import Contact Center logging helper`);
    assert.match(content, loggerPattern, `${path} must use the expected Phase C logger`);
  }
});

test("Phase C route handlers have no legacy console diagnostics or bracket-prefixed event strings", async () => {
  const forbidden = /console\.(log|warn|error|info|debug)|[`"]\[[A-Za-z0-9][^`"]*\]|_legacy_/;

  for (const path of Object.values(files).filter((path) => path !== files.helper)) {
    const content = await source(path);
    assert.doesNotMatch(content, forbidden, `${path} still contains legacy console/bracket diagnostics`);
  }
});

test("Phase C runtime logs use compact triage fields instead of full payload dumps", async () => {
  const forbiddenFullPayloadKeys = /\b(rawPayload|webhookPayload|fullPayload|requestBody|bodyText)\b/;
  const requiredContextHelpers = /callPayload|agentPayload|contactCenterErrorPayload/;

  for (const path of Object.values(files)) {
    const content = await source(path);
    assert.doesNotMatch(content, forbiddenFullPayloadKeys, `${path} must not log full or sensitive payload fields`);
  }

  for (const path of Object.values(files).filter((path) => path !== files.helper)) {
    const content = await source(path);
    assert.match(content, requiredContextHelpers, `${path} should include compact triage helper fields`);
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  helper: "lib/outbound-dialer/logging.mjs",
  runner: "lib/outbound-dialer/runner.js",
  agentCampaigns: "lib/outbound-dialer/agent-campaigns.js",
  overviewRoute: "app/api/contact-center/outbound-dialer/route.js",
  campaignRoutes: [
    "app/api/contact-center/outbound-dialer/campaigns/route.js",
    "app/api/contact-center/outbound-dialer/campaigns/[campaignId]/route.js",
    "app/api/contact-center/outbound-dialer/campaigns/[campaignId]/execution/route.js",
    "app/api/contact-center/outbound-dialer/settings/route.js",
  ],
  importRoutes: [
    "app/api/contact-center/outbound-dialer/contact-lists/[contactListId]/import/route.js",
    "app/api/contact-center/outbound-dialer/dnc-lists/[dncListId]/import/route.js",
  ],
  configurationRoutes: [
    "app/api/contact-center/outbound-dialer/contact-lists/route.js",
    "app/api/contact-center/outbound-dialer/contact-lists/[contactListId]/route.js",
    "app/api/contact-center/outbound-dialer/dnc-lists/route.js",
    "app/api/contact-center/outbound-dialer/dnc-lists/[dncListId]/route.js",
    "app/api/contact-center/outbound-dialer/time-sets/route.js",
    "app/api/contact-center/outbound-dialer/time-sets/[timeSetId]/route.js",
    "app/api/contact-center/outbound-dialer/disposition-codes/route.js",
    "app/api/contact-center/outbound-dialer/disposition-codes/[id]/route.js",
    "app/api/contact-center/outbound-dialer/attempt-controls/route.js",
    "app/api/contact-center/outbound-dialer/attempt-controls/[attemptControlId]/route.js",
    "app/api/contact-center/outbound-dialer/filters/route.js",
    "app/api/contact-center/outbound-dialer/filters/[filterId]/route.js",
    "app/api/contact-center/outbound-dialer/filters/test/route.js",
  ],
  liveCallRoutes: [
    "app/api/contact-center/outbound-dialer/live-calls/route.js",
    "app/api/contact-center/outbound-dialer/live-calls/stream/route.js",
  ],
};

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const allRuntimeFiles = [
  files.runner,
  files.agentCampaigns,
  files.overviewRoute,
  ...files.campaignRoutes,
  ...files.importRoutes,
  ...files.configurationRoutes,
  ...files.liveCallRoutes,
];

const forbiddenLegacyDiagnostics = /console\.(log|warn|error|info|debug)|[`"]\[[A-Za-z0-9][^`"]*\]/;
const forbiddenRawPayloadKeys = /\b(rawPayload|webhookPayload|eventPayload|fullPayload|requestBody|bodyText|csvContent)\b/;

test("Outbound Dialer logging helper exposes canonical topic loggers", async () => {
  const helper = await source(files.helper);

  assert.match(helper, /export const runnerLogger = createDiagnosticLogger\("outbound\.runner"\)/);
  assert.match(helper, /export const campaignsLogger = createDiagnosticLogger\("outbound\.campaigns"\)/);
  assert.match(helper, /export const executionLogger = createDiagnosticLogger\("outbound\.execution"\)/);
  assert.match(helper, /export const importsLogger = createDiagnosticLogger\("outbound\.imports"\)/);
  assert.match(helper, /export const liveCallsLogger = createDiagnosticLogger\("outbound\.live-calls"\)/);
});

test("Outbound Dialer runtime files use structured topic loggers without legacy diagnostics", async () => {
  const expectations = [
    [files.runner, /runnerLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.agentCampaigns, /campaignsLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.overviewRoute, /campaignsLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    ...files.campaignRoutes.map((path) => [path, /(campaignsLogger|executionLogger)\.(debug|info|warn|error)\("[a-z0-9_]+"/]),
    ...files.importRoutes.map((path) => [path, /importsLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/]),
    ...files.configurationRoutes.map((path) => [path, /campaignsLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/]),
    ...files.liveCallRoutes.map((path) => [path, /liveCallsLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/]),
  ];

  for (const [path, loggerPattern] of expectations) {
    const content = await source(path);
    assert.match(content, /outbound-dialer\/logging\.mjs|\.\.\/logging\.mjs|\.\/logging\.mjs/, `${path} must import Outbound Dialer logging helper`);
    assert.match(content, loggerPattern, `${path} must emit structured outbound events`);
    assert.doesNotMatch(content, forbiddenLegacyDiagnostics, `${path} still contains legacy console/bracket diagnostics`);
  }
});

test("Outbound Dialer logs keep compact triage fields and avoid raw sensitive payload keys", async () => {
  for (const path of [files.helper, ...allRuntimeFiles]) {
    const content = await source(path);
    assert.doesNotMatch(content, forbiddenRawPayloadKeys, `${path} must not log raw/sensitive payload fields`);
  }

  const combined = await Promise.all([files.helper, ...allRuntimeFiles].map(source)).then((parts) => parts.join("\n"));
  for (const field of ["campaignId", "contactListId", "dncListId", "attemptControlId", "callControlId", "reason"]) {
    assert.match(combined, new RegExp(`\\b${field}\\b`), `expected safe field ${field} in Outbound Dialer logging slice`);
  }
});

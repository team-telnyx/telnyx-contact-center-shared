import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel) => readFileSync(join(repoRoot, rel), "utf8");

test("site header exposes the headset integration badge next to softphone controls", () => {
  const siteHeader = src("components/site-header.jsx");
  assert.match(siteHeader, /from\s+["']@\/components\/headsets\/HeadsetStatusBadge["']/);
  assert.match(siteHeader, /<HeadsetStatusBadge\s*\/?>/);
  assert.match(siteHeader, /<SoftphoneMini\s*\/?>/);
});

test("headset status badge initializes the shared Jabra/EPOS headset service behind a browser feature flag", () => {
  const badge = src("components/headsets/HeadsetStatusBadge.jsx");
  const clientService = src("lib/headsets/client-headset-service.js");
  assert.match(badge, /initHeadsetControlService/);
  assert.match(badge, /isHeadsetIntegrationEnabled/);
  assert.match(badge, /requestPermission\("jabra"\)/);
  assert.match(clientService, /createJabraAdapter/);
  assert.match(clientService, /createEposAdapter/);
  assert.match(clientService, /NEXT_PUBLIC_HEADSET_INTEGRATION_ENABLED/);
});

test("softphone mini bridges headset commands and softphone state through the shared headset service", () => {
  const softphoneMini = src("components/softphone-mini.jsx");
  assert.match(softphoneMini, /getHeadsetControlService/);
  assert.match(softphoneMini, /setSoftphoneState/);
  assert.match(softphoneMini, /onCommand/);
  assert.match(softphoneMini, /HEADSET_COMMANDS\.ANSWER/);
  assert.match(softphoneMini, /HEADSET_COMMANDS\.MUTE/);
  assert.match(softphoneMini, /HEADSET_COMMANDS\.HOLD/);
});

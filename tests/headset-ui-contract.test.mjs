import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel) => readFileSync(join(repoRoot, rel), "utf8");

test("softphone mini owns the headset control trigger immediately before contact picker", () => {
  const siteHeader = src("components/site-header.jsx");
  const softphoneMini = src("components/softphone-mini.jsx");
  assert.doesNotMatch(siteHeader, /HeadsetStatusBadge/);
  assert.match(softphoneMini, /from\s+["']@\/components\/headsets\/HeadsetStatusBadge["']/);
  assert.match(softphoneMini, /<HeadsetStatusBadge\s*\/?>\s*<button[\s\S]*?title="Select number from contacts"/);
});

test("headset UI uses the shared Jabra/EPOS service and a right-side sheet", () => {
  const badge = src("components/headsets/HeadsetStatusBadge.jsx");
  const clientService = src("lib/headsets/client-headset-service.js");
  assert.match(badge, /initHeadsetControlService/);
  assert.match(badge, /isHeadsetIntegrationEnabled/);
  assert.match(badge, /requestPermission\("jabra"\)/);
  assert.match(badge, /onDiagnostic/);
  assert.match(badge, /recordDiagnostic\(diagnostic\.message/);
  assert.match(badge, /SheetContent[\s\S]*side="right"/);
  assert.doesNotMatch(badge, /DialogContent/);
  assert.match(clientService, /createJabraAdapter/);
  assert.match(clientService, /createEposAdapter/);
  assert.match(clientService, /NEXT_PUBLIC_HEADSET_INTEGRATION_ENABLED/);
});

test("headset sheet ships EPOS BTD 800 and MB Pro 2 catalog artwork", () => {
  const catalog = src("lib/headsets/headset-device-catalog.js");
  assert.match(catalog, /BTD 800 USB for Lync/);
  assert.match(catalog, /MB Pro 2/);
  assert.match(catalog, /\/images\/headsets\/epos\/btd-800-usb\.png/);
  assert.match(catalog, /\/images\/headsets\/epos\/mb-pro-2\.png/);
});

test("softphone publishes headset state while mini softphone owns headset commands", () => {
  const softphone = src("components/softphone.jsx");
  const softphoneMini = src("components/softphone-mini.jsx");

  assert.match(softphone, /getHeadsetControlService/);
  assert.match(softphone, /setSoftphoneState/);
  assert.doesNotMatch(softphone, /onCommand/);
  assert.doesNotMatch(softphone, /HEADSET_COMMANDS\./);

  assert.match(softphoneMini, /getHeadsetControlService/);
  assert.match(softphoneMini, /setSoftphoneState/);
  assert.match(softphoneMini, /onCommand/);
  assert.match(softphoneMini, /HEADSET_COMMANDS\.ANSWER/);
  assert.match(softphoneMini, /HEADSET_COMMANDS\.MUTE/);
  assert.match(softphoneMini, /HEADSET_COMMANDS\.HOLD/);
});

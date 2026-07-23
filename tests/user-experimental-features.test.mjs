import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("experimental access is stored per user and exposed by the current profile", async () => {
  const [schema, profile, updateRoute, usersEditor] = await Promise.all([
    read("lib/postgres-schema.mjs"),
    read("app/api/user/profile/route.js"),
    read("app/api/admin/users/[id]/route.js"),
    read("components/users/EditSheet.jsx"),
  ]);

  assert.match(schema, /experimental_features BOOLEAN NOT NULL DEFAULT false/);
  assert.match(profile, /experimental_features: user\.experimental_features === true/);
  assert.match(updateRoute, /"experimentalFeatures"[\s\S]*Boolean\(body\.experimentalFeatures\)/);
  assert.match(usersEditor, /Experimental features/);
  assert.match(usersEditor, /Translation\/TTS, Phones Provisioning, and headset integrations/);
  assert.match(usersEditor, /experimentalFeatures,/);
});

test("the client feature state loads once and refreshes through an explicit account event", async () => {
  const client = await read("lib/experimental-features-client.js");

  assert.match(client, /fetch\("\/api\/user\/profile", \{ cache: "no-store" \}\)/);
  assert.match(client, /experimental-features:refresh/);
  assert.match(client, /window\.addEventListener\(REFRESH_EVENT, handleRefreshEvent\)/);
  assert.doesNotMatch(client, /setInterval|REFRESH_INTERVAL_MS|visibilitychange/);
});

test("Agent Assist translation and TTS use the per-user feature flag", async () => {
  const [page, editor] = await Promise.all([
    read("app/(portal)/admin/call-flows/[id]/page.jsx"),
    read("components/voice-flow/AgentAssistNodeEditor.jsx"),
  ]);

  assert.match(page, /useExperimentalFeatures\(\)/);
  assert.match(page, /experimentalFeaturesEnabled=\{experimentalFeaturesEnabled\}/);
  assert.match(editor, /experimentalFeaturesEnabled &&/);
  assert.doesNotMatch(editor, /NEXT_PUBLIC_EXPERIMENTAL_USER/);
});

test("Phones Provisioning UI and admin APIs require experimental access", async () => {
  const provisioningRoutes = [
    "app/api/admin/phones-provisioning/bridges/route.js",
    "app/api/admin/phones-provisioning/dashboard/route.js",
    "app/api/admin/phones-provisioning/logs/route.js",
    "app/api/admin/phones-provisioning/phones/route.js",
    "app/api/admin/phones-provisioning/phones/[id]/route.js",
    "app/api/admin/phones-provisioning/phones/[id]/cti/route.js",
    "app/api/admin/phones-provisioning/phones/reboot/route.js",
  ];
  const [page, systemNav, ...routeSources] = await Promise.all([
    read("app/(portal)/admin/phones-provisioning/page.jsx"),
    read("components/admin/SystemSectionNav.jsx"),
    ...provisioningRoutes.map(read),
  ]);

  assert.match(page, /router\.replace\("\/admin\/system"\)/);
  assert.match(systemNav, /item\.id !== "phones-provisioning"/);
  for (const [index, routeSource] of routeSources.entries()) {
    assert.match(
      routeSource,
      /user\.experimental_features !== true/,
      `${provisioningRoutes[index]} should enforce the per-user feature gate`,
    );
  }
});

test("WebRTC headset state, UI, and command handling require experimental access", async () => {
  const mini = await read("components/softphone-mini.jsx");

  assert.match(mini, /experimentalFeaturesEnabled \? <HeadsetStatusBadge \/> : null/);
  assert.match(mini, /if \(!experimentalFeaturesEnabled\) return;[\s\S]*initHeadsetControlService/);
  assert.match(mini, /if \(!experimentalFeaturesEnabled\) return;[\s\S]*onCommand/);
});

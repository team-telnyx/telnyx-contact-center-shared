import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const files = {
  page: new URL("../app/(portal)/admin/logging/page.jsx", import.meta.url),
  schema: new URL("../lib/postgres-schema.mjs", import.meta.url),
  seedSettings: new URL("../lib/seed-app-settings.mjs", import.meta.url),
  seedDomains: new URL("../lib/seed-domains.mjs", import.meta.url),
  seedOwner: new URL("../lib/seed-default-owner.mjs", import.meta.url),
  seedWorkflows: new URL("../lib/seed-sample-workflows.mjs", import.meta.url),
  ghostCleanup: new URL("../lib/contact-center/ghost-call-cleanup.mjs", import.meta.url),
  streaming: new URL("../lib/streaming-ws-handler.mjs", import.meta.url),
  startWrapper: new URL("../scripts/start-next-with-pino.mjs", import.meta.url),
  packageJson: new URL("../package.json", import.meta.url),
  productionDockerfile: new URL("../docker/production/Dockerfile", import.meta.url),
};

async function source(file) {
  return readFile(file, "utf8");
}

test("Live logging topic filter is a configured-topic dropdown, not free text", async () => {
  const src = await source(files.page);

  assert.match(src, /<LogFiltersPanel[\s\S]*topics=\{topics\}/);
  assert.match(src, /function LogFiltersPanel\(\{ files, filters, currentFile, topics, update, onApply, loading \}\)/);
  assert.match(src, /ConfigSelect label="Topic"/);
  assert.match(src, /All topics/);
  assert.match(src, /\.\.\.topics\.map\(\(topic\) => \(\{ value: topic, label: topic \}\)\)/);
  assert.doesNotMatch(src, /<Input placeholder="telnyx\.stt" value=\{filters\.topic\}/);
});

test("startup modules use pino diagnostic loggers instead of legacy bracket console output", async () => {
  for (const [name, file] of Object.entries(files)) {
    if (["page", "startWrapper", "packageJson", "productionDockerfile"].includes(name)) continue;
    const src = await source(file);
    assert.doesNotMatch(src, /console\.(log|warn|error)\(/, `${name} should not call console.* directly during startup`);
    assert.doesNotMatch(src, /\[(Postgres|Seed|Seed Domains|Seed Owner|Seed Workflows|GhostCallCleanup|Streaming WS)\]/, `${name} should not emit legacy bracket-prefixed startup messages`);
  }
});

test("startup modules expose structured pino event names for schema, seed, cleanup, and streaming milestones", async () => {
  const schema = await source(files.schema);
  const seedSettings = await source(files.seedSettings);
  const seedDomains = await source(files.seedDomains);
  const seedOwner = await source(files.seedOwner);
  const seedWorkflows = await source(files.seedWorkflows);
  const ghostCleanup = await source(files.ghostCleanup);
  const streaming = await source(files.streaming);

  assert.match(schema, /postgres_schema_created/);
  assert.match(schema, /aa_ai_handoff_events_table_ready/);
  assert.match(seedSettings, /seed_app_settings_/);
  assert.match(seedDomains, /seed_domains_/);
  assert.match(seedOwner, /seed_owner_/);
  assert.match(seedWorkflows, /seed_workflows_complete/);
  assert.match(ghostCleanup, /ghost_call_cleanup_/);
  assert.match(streaming, /streaming_ws_listening/);
  assert.match(streaming, /streaming_ws_routes_ready/);
});


test("production start is wrapped so Next CLI ready lines become pino events", async () => {
  const startWrapper = await source(files.startWrapper);
  const packageJson = JSON.parse(await source(files.packageJson));
  const dockerfile = await source(files.productionDockerfile);

  assert.equal(packageJson.scripts.start, "NODE_ENV=production node scripts/start-next-with-pino.mjs");
  assert.match(startWrapper, /^import nextEnv from "@next\/env";/m);
  assert.ok(
    startWrapper.indexOf('import nextEnv from "@next/env";') < startWrapper.indexOf('import { createDiagnosticLogger }'),
    "start wrapper must import Next env support before creating the pino logger",
  );
  assert.match(startWrapper, /tryLoadRuntimeLoggingConfigEarly/);
  assert.match(startWrapper, /const runtimeLoggingConfig = await tryLoadRuntimeLoggingConfigEarly\(\)/);
  assert.match(startWrapper, /loadEnvConfig\(process\.cwd\(\), nodeEnv !== "production"\)/);
  assert.match(startWrapper, /getConfig: \(\) => runtimeLoggingConfig/);
  assert.match(startWrapper, /web_server_starting/);
  assert.match(startWrapper, /web_server_ready/);
  assert.match(startWrapper, /web_server_next_runtime/);
  assert.match(startWrapper, /web_server_endpoint/);
  assert.match(startWrapper, /nextCliStartingLineSuppressed/);
  assert.match(startWrapper, /next", "start"/);
  assert.doesNotMatch(packageJson.scripts.start, /next start --hostname/);
  assert.doesNotMatch(dockerfile, /Starting Next\.js production server/);
});

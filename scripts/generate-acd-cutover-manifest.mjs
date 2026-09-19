#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
export const MANIFEST_PATH = path.join(
  REPOSITORY_ROOT,
  "the internal documentation",
);

export const RETIRED_RUNTIME_TABLES = Object.freeze([
  "cc_interactions",
  "cc_agent_state",
  "cc_agent_reservations",
  "cc_processed_events",
  "cc_coordinator_leases",
  "cc_queue_state",
  "cc_queue_statistics",
  "cc_queue_sla_metrics",
  "cc_agent_status_history",
  "cc_user_time_tracking",
  "cc_session_presence",
]);

export const CORE_RUNTIME_TABLES = Object.freeze([
  "acd_sla_measurements",
  "acd_work_items",
  "acd_segments",
  "acd_legs",
  "acd_leg_intents",
  "acd_offers",
  "acd_reservations",
  "acd_agent_state",
  "acd_agent_sessions",
  "acd_sagas",
  "acd_commands",
  "acd_events",
  "acd_outbox",
  "acd_webhook_events",
  "acd_stream_events",
]);

export const RETIRED_IDENTIFIERS = Object.freeze([
  ...RETIRED_RUNTIME_TABLES,
  "engine_owner",
  "state_authority",
  "legacy_interaction_id",
  "intake_owner",
  "ACD_SHADOW",
  "acd_guard_legacy_agent_projection",
  "acd_infer_webhook_intake_owner",
  "lib/acd/shadow-intake",
  "lib/acd/projection",
  "lib/acd/legacy-compat",
  "lib/contact-center/coordinator",
  "lib/contact-center/coordinator-lease",
  "lib/contact-center/routing-reactor",
  "lib/contact-center/routing-events",
  "lib/contact-center/queued-call-router",
  "lib/contact-center/routing-engine",
  "lib/contact-center/reservation-manager",
  "lib/contact-center/agent-answer-timeout",
  "lib/contact-center/skills-re-evaluator",
  "lib/contact-center/waiting-reason-re-evaluator",
  "lib/contact-center/ghost-call-cleanup",
  "lib/contact-center/state-manager",
  "lib/contact-center/webrtc-bridge",
  "lib/contact-center/direct-agent-call-lifecycle",
  "lib/contact-center/agent-call-lifecycle-status",
  "lib/contact-center/agent-status-transition",
  "lib/contact-center/user-status",
  "lib/contact-center/stats-aggregator",
  "lib/contact-center/sla-tracker",
  "lib/contact-center/call-timeline-tracker",
  "lib/contact-center/call-metrics-tracker",
  "lib/contact-center/agent-status-intervals",
  "lib/contact-center/session-presence",
]);

export const RETIRED_DATABASE_OBJECTS = Object.freeze([
  ...RETIRED_RUNTIME_TABLES.map((name) => ({ type: "table", name })),
  { type: "table", name: "acd_provider_recovery" },
  { type: "table", name: "aa_schema_backfills" },
  { type: "trigger", name: "acd_guard_legacy_agent_projection" },
  { type: "function", name: "acd_infer_webhook_intake_owner" },
]);

export const TEMPORARY_EXTERNAL_CORE_WRITE_EXCEPTIONS = Object.freeze([]);

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".sql",
]);
const PRODUCTION_ROOTS = ["app", "components", "lib", "scripts"];
const PRODUCTION_TOP_LEVEL = [
  "instrumentation.js",
  "middleware.js",
  "next.config.js",
  "next.config.mjs",
];
const CUTOVER_CONTROL_PATHS = new Set([
  "scripts/generate-acd-cutover-manifest.mjs",
  // The destructive reset tool introduced in C7 must name the objects it
  // removes. It is migration evidence, not a production runtime dependency.
  "scripts/acd-core-cutover-reset.mjs",
]);

function posixRelative(file) {
  return path.relative(REPOSITORY_ROOT, file).split(path.sep).join("/");
}

function collectFiles(entry) {
  if (!existsSync(entry)) return [];
  if (statSync(entry).isFile()) {
    return SOURCE_EXTENSIONS.has(path.extname(entry)) ? [entry] : [];
  }
  const files = [];
  for (const item of readdirSync(entry, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git", "coverage"].includes(item.name)) {
      continue;
    }
    const child = path.join(entry, item.name);
    if (item.isDirectory()) files.push(...collectFiles(child));
    else if (SOURCE_EXTENSIONS.has(path.extname(item.name))) files.push(child);
  }
  return files;
}

function productionFiles() {
  return [
    ...PRODUCTION_ROOTS.flatMap((root) =>
      collectFiles(path.join(REPOSITORY_ROOT, root)),
    ),
    ...PRODUCTION_TOP_LEVEL.flatMap((file) =>
      collectFiles(path.join(REPOSITORY_ROOT, file)),
    ),
  ]
    .filter((file) => !CUTOVER_CONTROL_PATHS.has(posixRelative(file)))
    .sort();
}

function testFiles() {
  return collectFiles(path.join(REPOSITORY_ROOT, "tests")).sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countIdentifier(content, identifier) {
  const boundaryStart = /^[a-z0-9_]$/i.test(identifier[0]) ? "\\b" : "";
  const boundaryEnd = /^[a-z0-9_]$/i.test(identifier.at(-1)) ? "\\b" : "";
  return [
    ...content.matchAll(
      new RegExp(
        `${boundaryStart}${escapeRegExp(identifier)}${boundaryEnd}`,
        "gi",
      ),
    ),
  ].length;
}

function referenceInventory(files, identifiers) {
  const inventory = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const matches = identifiers
      .map((identifier) => ({
        identifier,
        count: countIdentifier(content, identifier),
      }))
      .filter((match) => match.count > 0);
    if (matches.length > 0) {
      inventory.push({ path: posixRelative(file), matches });
    }
  }
  return inventory;
}

function sqlMutations(files, tables) {
  const accepted = new Set(tables.map((table) => table.toLowerCase()));
  const records = new Map();
  const mutation = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?["`]?([a-z_][a-z0-9_]*)["`]?/gi;
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(mutation)) {
      const table = match[2].toLowerCase();
      if (!accepted.has(table)) continue;
      const operation = match[1].toLowerCase().startsWith("insert")
        ? "insert"
        : match[1].toLowerCase().startsWith("delete")
          ? "delete"
          : "update";
      const key = `${posixRelative(file)}\u0000${operation}\u0000${table}`;
      records.set(key, {
        path: posixRelative(file),
        operation,
        table,
        count: (records.get(key)?.count || 0) + 1,
      });
    }
  }
  return [...records.values()].sort((left, right) =>
    `${left.path}:${left.table}:${left.operation}`.localeCompare(
      `${right.path}:${right.table}:${right.operation}`,
    ),
  );
}

function definitionPattern(object) {
  const name = escapeRegExp(object.name);
  if (object.type === "table") {
    return new RegExp(`\\bCREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+${name}\\b`, "gi");
  }
  if (object.type === "trigger") {
    return new RegExp(`\\bCREATE\\s+TRIGGER\\s+${name}\\b`, "gi");
  }
  return new RegExp(
    `\\bCREATE(?:\\s+OR\\s+REPLACE)?\\s+FUNCTION\\s+${name}\\b`,
    "gi",
  );
}

function databaseDefinitions(files) {
  const definitions = [];
  for (const object of RETIRED_DATABASE_OBJECTS) {
    const locations = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const count = [...content.matchAll(definitionPattern(object))].length;
      if (count > 0) locations.push({ path: posixRelative(file), count });
    }
    definitions.push({ ...object, definitions: locations });
  }
  return definitions;
}

function totals(manifest) {
  const referenceCount = (entries) =>
    entries.reduce(
      (sum, entry) =>
        sum + entry.matches.reduce((inner, match) => inner + match.count, 0),
      0,
    );
  const mutationCount = (entries) =>
    entries.reduce((sum, entry) => sum + entry.count, 0);
  return {
    productionLegacyReferenceFiles: manifest.production.legacyReferences.length,
    productionLegacyReferences: referenceCount(
      manifest.production.legacyReferences,
    ),
    productionLegacyWrites: mutationCount(manifest.production.legacyWrites),
    testLegacyReferenceFiles: manifest.tests.legacyReferences.length,
    testLegacyReferences: referenceCount(manifest.tests.legacyReferences),
    testLegacyWrites: mutationCount(manifest.tests.legacyWrites),
    externalCoreWrites: mutationCount(
      manifest.production.coreWritesOutsideAcd,
    ),
    retiredDatabaseDefinitions: manifest.database.objects.reduce(
      (sum, object) =>
        sum + object.definitions.reduce((inner, item) => inner + item.count, 0),
      0,
    ),
  };
}

export function buildAcdCutoverManifest() {
  const production = productionFiles();
  const tests = testFiles();
  const allSource = [...new Set([...production, ...tests])].sort();
  const coreWrites = sqlMutations(production, CORE_RUNTIME_TABLES);
  const manifest = {
    schemaVersion: 1,
    purpose:
      "Versioned C1 inventory for removing the legacy voice runtime during the ACD Core total cutover.",
    generatedBy: "node scripts/generate-acd-cutover-manifest.mjs --write",
    targetZero: {
      productionLegacyReferences: 0,
      productionLegacyWrites: 0,
      testLegacyReferences: 0,
      externalCoreWrites: 0,
      retiredDatabaseDefinitions: 0,
    },
    temporaryExternalCoreWriteExceptions:
      TEMPORARY_EXTERNAL_CORE_WRITE_EXCEPTIONS,
    production: {
      legacyReferences: referenceInventory(production, RETIRED_IDENTIFIERS),
      legacyWrites: sqlMutations(production, RETIRED_RUNTIME_TABLES),
      coreWritesOutsideAcd: coreWrites.filter(
        (record) => !record.path.startsWith("lib/acd/"),
      ),
    },
    tests: {
      legacyReferences: referenceInventory(tests, RETIRED_IDENTIFIERS),
      legacyWrites: sqlMutations(tests, RETIRED_RUNTIME_TABLES),
    },
    database: {
      objects: databaseDefinitions(allSource),
    },
  };
  return { ...manifest, totals: totals(manifest) };
}

export function serializeAcdCutoverManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function main() {
  const command = process.argv[2] || "--check";
  const generated = serializeAcdCutoverManifest(buildAcdCutoverManifest());
  if (command === "--write") {
    writeFileSync(MANIFEST_PATH, generated);
    process.stdout.write(`Wrote ${posixRelative(MANIFEST_PATH)}\n`);
    return;
  }
  if (command !== "--check") {
    throw new Error(`Unsupported option: ${command}`);
  }
  const current = existsSync(MANIFEST_PATH)
    ? readFileSync(MANIFEST_PATH, "utf8")
    : "";
  if (current !== generated) {
    process.stderr.write(
      "ACD cutover dependency manifest is stale. Run: node scripts/generate-acd-cutover-manifest.mjs --write\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("ACD cutover dependency manifest is current.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

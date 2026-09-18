import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyCatalog,
  computeCutoverToken,
  dropLegacyFunctions,
  DROP_RUNTIME,
  PRESERVE_CONFIGURATION,
  RESET_AUXILIARY_RUNTIME,
  RESET_CORE_RUNTIME,
} from "../scripts/acd-core-cutover-reset.mjs";

test("cutover catalog classification fails closed on unknown objects", () => {
  const catalog = {
    tables: [
      { name: "contacts" },
      { name: "acd_work_items" },
      { name: "unexpected_voice_state" },
    ],
    views: [
      { name: "acd_history_interactions" },
      { name: "unexpected_runtime_view" },
    ],
    sequences: [
      { name: "acd_events_id_seq", table_name: "acd_events" },
      { name: "orphan_sequence", table_name: null },
    ],
    triggers: [
      { name: "cg_actions_updated_at_trigger", table_name: "cg_actions" },
      { name: "unexpected_trigger", table_name: "missing_table" },
    ],
    functions: [
      { name: "gen_random_uuid" },
      { name: "acd_unclassified_mutator" },
    ],
    foreignKeys: [
      {
        name: "known_fk",
        source_table: "outbound_campaigns",
        target_table: "outbound_contact_lists",
      },
      {
        name: "unknown_fk",
        source_table: "unexpected_voice_state",
        target_table: "users",
      },
    ],
  };

  const result = classifyCatalog(catalog);
  assert.deepEqual(
    result.unknown.map((entry) => entry.type),
    ["table", "view", "sequence", "trigger", "function", "foreign_key"],
  );
});

test("cutover token is stable and changes with database evidence", () => {
  const report = {
    database: "contact_center",
    git: { commit: "abc", dirty: false, statusHash: "hash" },
    schemaFingerprint: "schema",
    preserve: { contacts: { count: 2, stableHash: "contacts" } },
    rowCounts: { acd_work_items: 0 },
    providerConfiguration: { sipConnectionId: "connection" },
    blockers: [{ name: "live_work_items", count: 0 }],
    catalog: { unknown: [] },
  };
  const first = computeCutoverToken(report);
  const reordered = computeCutoverToken({
    ...report,
    preserve: { contacts: { stableHash: "contacts", count: 2 } },
  });
  assert.equal(first, reordered);
  assert.match(first, /^ACD-[A-F0-9]{24}$/);
  assert.notEqual(
    first,
    computeCutoverToken({
      ...report,
      rowCounts: { acd_work_items: 1 },
    }),
  );
});

test("cutover manifest dispositions are explicit and disjoint", () => {
  const groups = [
    PRESERVE_CONFIGURATION,
    RESET_CORE_RUNTIME,
    RESET_AUXILIARY_RUNTIME,
    DROP_RUNTIME,
  ];
  const all = groups.flat();
  assert.equal(new Set(all).size, all.length);
  assert.ok(PRESERVE_CONFIGURATION.includes("contacts"));
  assert.ok(RESET_CORE_RUNTIME.includes("acd_work_items"));
  assert.ok(RESET_AUXILIARY_RUNTIME.includes("outbound_attempt_ledger"));
  assert.ok(DROP_RUNTIME.some((table) => table.endsWith("interactions")));
});

test("cutover execution does not use cascading truncate", async () => {
  const source = await readFile(
    new URL("../scripts/acd-core-cutover-reset.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /TRUNCATE\b/i);
  assert.doesNotMatch(source, /DROP\s+TABLE[^;]+CASCADE/i);
  assert.match(source, /BEGIN ISOLATION LEVEL SERIALIZABLE/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /assertPreserved/);
  const triggerRemovalPhase = source.indexOf("for (const [trigger, table] of [");
  const columnRemovalPhase = source.indexOf(
    "for (const [table, column] of [",
    triggerRemovalPhase,
  );
  assert.ok(
    triggerRemovalPhase >= 0 && columnRemovalPhase > triggerRemovalPhase,
    "compatibility triggers must be removed before their referenced columns",
  );
});

test("legacy functions are dropped by their identity signature, overloads included", async () => {
  const statements = [];
  const client = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (/FROM pg_proc/.test(sql)) {
        if (params[0] === "legacy_probe_fn") {
          return { rows: [
            { signature: "legacy_probe_fn(text,jsonb)" },
            { signature: "legacy_probe_fn(text)" },
          ] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const dropped = await dropLegacyFunctions(client, ["legacy_probe_fn", "legacy_probe_absent_fn"]);
  assert.deepEqual(dropped, [
    "legacy_probe_fn(text,jsonb)",
    "legacy_probe_fn(text)",
  ]);
  const drops = statements.filter((entry) => /^DROP FUNCTION/.test(entry.sql)).map((entry) => entry.sql);
  assert.deepEqual(drops, [
    "DROP FUNCTION IF EXISTS legacy_probe_fn(text,jsonb)",
    "DROP FUNCTION IF EXISTS legacy_probe_fn(text)",
  ]);
  assert.ok(!drops.some((sql) => /\(\)$/.test(sql)), "a zero-argument drop never matched a parameterised function");
});

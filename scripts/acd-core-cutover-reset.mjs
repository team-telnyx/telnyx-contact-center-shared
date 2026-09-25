#!/usr/bin/env node

// These two must stay the first imports and stay in this order: the flag has
// to be set before `dotenv/config` is evaluated, and .env has to be loaded
// before any import that reads process.env while being evaluated. The flag
// module explains both. `dotenv/config` rather than a config() call so that
// DOTENV_CONFIG_PATH still selects which .env is read.
import "./lib/dotenv-quiet-flag.mjs";
import "dotenv/config";

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getPostgresPool } from "../lib/postgres.mjs";
import { ensureAcdSchema } from "../lib/acd/schema.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const PRESERVE_CONFIGURATION = Object.freeze([
  "cc_sla_policy_audit",
  "contacts",
  "outbound_campaigns",
  "outbound_campaign_agent_assignments",
  "outbound_contact_lists",
  "outbound_contact_records",
  "outbound_contact_filters",
  "outbound_attempt_controls",
  "outbound_disposition_code_mappings",
  "outbound_dnc_lists",
  "outbound_dnc_entries",
  "outbound_settings",
  "outbound_time_sets",
  "form_definitions",
  "form_versions",
  "form_media_assets",
  "form_templates",
  "aa_workflows",
  "aa_workflow_stages",
  "aa_workflow_items",
  "quality_forms",
  "quality_form_versions",
  "voice_flows",
  "voice_flow_phone_numbers",
  "cg_scenarios",
  "cg_actions",
  "cg_settings",
  "hp_phones",
  "hp_local_bridges",
]);

export const RESET_CORE_RUNTIME = Object.freeze([
  "acd_sla_measurements",
  "acd_action_requests",
  "acd_agent_sessions",
  "acd_agent_state",
  "acd_commands",
  "acd_direct_intents",
  "acd_events",
  "acd_leg_intents",
  "acd_legs",
  "acd_offers",
  "acd_operator_actions",
  "acd_outbound_lines",
  "acd_outbound_schedule",
  "acd_outbox",
  "acd_recordings",
  "acd_reservations",
  "acd_retention_watermarks",
  "acd_sagas",
  "acd_segments",
  "acd_stream_events",
  "acd_transcripts",
  "acd_webhook_events",
  "acd_work_item_annotations",
  "acd_work_items",
  "voice_webhook_dedupe",
]);

export const RESET_AUXILIARY_RUNTIME = Object.freeze([
  "outbound_campaign_runs",
  "outbound_attempt_ledger",
  "outbound_webhook_events",
  "form_submissions",
  "aa_workflow_sessions",
  "aa_workflow_item_status",
  "aa_ai_handoff_events",
  "quality_evaluations",
  "quality_ai_jobs",
  "voice_flow_executions",
  "cg_runs",
  "cg_call_ledger",
  "cg_commands",
  "cg_webhook_inbox",
  "cg_runtime_state",
  "hp_provisioning_events",
  "hp_cti_sessions",
  "hp_local_bridge_commands",
  "cc_user_sessions",
  "cc_user_activity_log",
  "cc_agent_status_intervals",
]);

export const DROP_RUNTIME = Object.freeze([
  "acd_provider_recovery",
  "aa_schema_backfills",
  "cc_session_presence",
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
]);

export const UNAFFECTED_PLATFORM = Object.freeze([
  "users",
  "skills",
  "agent_groups",
  "domains",
  "auth_users",
  "auth_accounts",
  "auth_sessions",
  "auth_verification_tokens",
  "app_settings",
  "app_logging_config",
  "app_logging_config_audit",
  "app_logging_user_preferences",
  "cc_queues",
  "cc_wrapup_codes",
  "cc_queue_wrapup_codes",
  "cc_queue_user_assignments",
  "cc_user_statuses",
  "secrets",
  "mcp_servers",
  "mcp_server_tools",
  "kb_articles",
  "tasks",
  "web_pages",
]);

const LEGACY_TRIGGERS = new Set([
  "acd_guard_legacy_agent_projection",
  "acd_webhook_assign_intake_owner",
  "acd_webhook_intake_owner_immutable",
  "acd_compat_work_item_control",
]);

const LEGACY_FUNCTIONS = new Set([
  "acd_infer_webhook_intake_owner",
  "acd_webhook_assign_intake_owner",
  "acd_webhook_intake_owner_immutable",
  "acd_compat_work_item_control",
]);

// `DROP FUNCTION name()` only matches a zero-argument overload, so a legacy
// function with parameters (the intake-owner inference takes text, jsonb)
// silently survived the reset. Resolve every overload from the catalog and
// drop each by its identity signature.
export async function dropLegacyFunctions(client, names = LEGACY_FUNCTIONS) {
  const dropped = [];
  for (const functionName of names) {
    const overloads = await client.query(
      `SELECT p.oid::regprocedure::text AS signature
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $1
        ORDER BY 1`,
      [functionName],
    );
    for (const row of overloads.rows) {
      await client.query(`DROP FUNCTION IF EXISTS ${row.signature}`);
      dropped.push(row.signature);
    }
  }
  return dropped;
}

const STABLE_HASH_EXCLUSIONS = Object.freeze({
  contacts: ["interaction_count", "last_interaction_at"],
  form_media_assets: ["updated_at"],
  form_templates: ["updated_at"],
  outbound_campaigns: ["status"],
  outbound_contact_records: ["last_attempt_at"],
  cg_actions: ["updated_at"],
  hp_local_bridges: ["status", "last_seen_at"],
  hp_phones: [
    "provisioning_state",
    "last_seen_at",
    "last_user_agent",
    "last_ip",
    "sip_registration_status",
    "updated_at",
  ],
});

const TABLE_DISPOSITION = new Map([
  ...PRESERVE_CONFIGURATION.map((name) => [name, "preserve_configuration"]),
  ...RESET_CORE_RUNTIME.map((name) => [name, "reset_core_runtime"]),
  ...RESET_AUXILIARY_RUNTIME.map((name) => [name, "reset_auxiliary_runtime"]),
  ...DROP_RUNTIME.map((name) => [name, "drop"]),
  ...UNAFFECTED_PLATFORM.map((name) => [name, "unaffected_platform"]),
]);

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function publicCatalog(db) {
  const [tables, views, sequences, triggers, functions, foreignKeys] =
    await Promise.all([
      db.query(
        `SELECT table_name AS name
           FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
      ),
      db.query(
        `SELECT table_name AS name
           FROM information_schema.views
          WHERE table_schema = 'public'
          ORDER BY table_name`,
      ),
      db.query(
        `SELECT sequence.relname AS name, owned_table.relname AS table_name
           FROM pg_class sequence
           JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
           LEFT JOIN pg_depend dependency
             ON dependency.objid = sequence.oid
            AND dependency.deptype IN ('a', 'i')
           LEFT JOIN pg_class owned_table ON owned_table.oid = dependency.refobjid
          WHERE namespace.nspname = 'public' AND sequence.relkind = 'S'
          ORDER BY sequence.relname`,
      ),
      db.query(
        `SELECT table_class.relname AS table_name, trigger.tgname AS name
           FROM pg_trigger trigger
           JOIN pg_class table_class ON table_class.oid = trigger.tgrelid
           JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
          WHERE namespace.nspname = 'public' AND NOT trigger.tgisinternal
          ORDER BY table_class.relname, trigger.tgname`,
      ),
      db.query(
        `SELECT DISTINCT procedure.proname AS name
           FROM pg_proc procedure
           JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = 'public'
          ORDER BY procedure.proname`,
      ),
      db.query(
        `SELECT constraint_record.conname AS name,
                source.relname AS source_table,
                target.relname AS target_table
           FROM pg_constraint constraint_record
           JOIN pg_class source ON source.oid = constraint_record.conrelid
           JOIN pg_class target ON target.oid = constraint_record.confrelid
           JOIN pg_namespace namespace ON namespace.oid = source.relnamespace
          WHERE namespace.nspname = 'public' AND constraint_record.contype = 'f'
          ORDER BY source.relname, constraint_record.conname`,
      ),
    ]);
  return {
    tables: tables.rows,
    views: views.rows,
    sequences: sequences.rows,
    triggers: triggers.rows,
    functions: functions.rows,
    foreignKeys: foreignKeys.rows,
  };
}

export function classifyCatalog(catalog) {
  const unknown = [];
  const classified = {
    tables: [],
    views: [],
    sequences: [],
    triggers: [],
    functions: [],
    foreignKeys: [],
  };

  for (const row of catalog.tables) {
    const disposition = TABLE_DISPOSITION.get(row.name);
    if (!disposition) unknown.push({ type: "table", name: row.name });
    classified.tables.push({ ...row, disposition: disposition || "unknown" });
  }
  for (const row of catalog.views) {
    const disposition = row.name === "acd_history_interactions"
      ? "core_read_model"
      : "unknown";
    if (disposition === "unknown") unknown.push({ type: "view", name: row.name });
    classified.views.push({ ...row, disposition });
  }
  for (const row of catalog.sequences) {
    const disposition = row.table_name
      ? TABLE_DISPOSITION.get(row.table_name)
      : null;
    if (!disposition) unknown.push({ type: "sequence", name: row.name });
    classified.sequences.push({ ...row, disposition: disposition || "unknown" });
  }
  for (const row of catalog.triggers) {
    const disposition = LEGACY_TRIGGERS.has(row.name)
      ? "drop"
      : TABLE_DISPOSITION.get(row.table_name);
    if (!disposition) unknown.push({ type: "trigger", name: row.name, table: row.table_name });
    classified.triggers.push({ ...row, disposition: disposition || "unknown" });
  }
  for (const row of catalog.functions) {
    const disposition = LEGACY_FUNCTIONS.has(row.name)
      ? "drop"
      : row.name.startsWith("acd_")
        ? "unknown"
        : "unaffected_platform";
    if (disposition === "unknown") unknown.push({ type: "function", name: row.name });
    classified.functions.push({ ...row, disposition });
  }
  for (const row of catalog.foreignKeys) {
    const source = TABLE_DISPOSITION.get(row.source_table);
    const target = TABLE_DISPOSITION.get(row.target_table);
    const disposition = source && target ? "classified" : "unknown";
    if (disposition === "unknown") {
      unknown.push({
        type: "foreign_key",
        name: row.name,
        sourceTable: row.source_table,
        targetTable: row.target_table,
      });
    }
    classified.foreignKeys.push({ ...row, disposition });
  }
  return { classified, unknown };
}

async function tableExists(db, name) {
  const result = await db.query("SELECT to_regclass($1) IS NOT NULL AS present", [
    `public.${name}`,
  ]);
  return result.rows[0]?.present === true;
}

async function columnExists(db, table, column) {
  const result = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS present`,
    [table, column],
  );
  return result.rows[0]?.present === true;
}

async function countRows(db, table, where = "TRUE") {
  if (!(await tableExists(db, table))) return null;
  const result = await db.query(
    `SELECT count(*)::bigint AS count FROM ${quoteIdentifier(table)} WHERE ${where}`,
  );
  return Number(result.rows[0]?.count || 0);
}

async function stableTableHash(db, table) {
  if (!(await tableExists(db, table))) return null;
  const excluded = STABLE_HASH_EXCLUSIONS[table] || [];
  const result = await db.query(
    `SELECT COALESCE(jsonb_agg(stable_row ORDER BY stable_row::text), '[]'::jsonb)::text AS payload
       FROM (
         SELECT to_jsonb(row_value) - $1::text[] AS stable_row
           FROM ${quoteIdentifier(table)} row_value
       ) stable_rows`,
    [excluded],
  );
  return sha256(result.rows[0]?.payload || "[]");
}

function gitState(repositoryRoot) {
  const run = (args) =>
    execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const commit = run(["rev-parse", "HEAD"]);
    const status = run(["status", "--porcelain"]);
    return { commit, dirty: Boolean(status), statusHash: sha256(status) };
  } catch {
    return { commit: null, dirty: true, statusHash: null };
  }
}

async function schemaFingerprint(db) {
  const result = await db.query(
    `SELECT jsonb_build_object(
       'columns', (
         SELECT jsonb_agg(to_jsonb(columns_record) ORDER BY table_name, ordinal_position)
           FROM (
             SELECT table_name, column_name, ordinal_position, data_type, udt_name,
                    is_nullable, column_default
               FROM information_schema.columns
              WHERE table_schema = 'public'
           ) columns_record
       ),
       'constraints', (
         SELECT jsonb_agg(to_jsonb(constraint_record) ORDER BY table_name, constraint_name)
           FROM (
             SELECT table_name, constraint_name, constraint_type
               FROM information_schema.table_constraints
              WHERE table_schema = 'public'
           ) constraint_record
       )
     )::text AS payload`,
  );
  return sha256(result.rows[0]?.payload || "{}");
}

async function providerConfiguration(db) {
  const data = {
    sipConnectionId: process.env.TELNYX_SIP_CONNECTION_ID || null,
    webhookBaseUrl:
      process.env.TELNYX_WEBHOOK_BASE_URL ||
      process.env.APP_BASE_URL ||
      process.env.NEXT_PUBLIC_BASE_URL ||
      null,
    voiceApplications: [],
    phoneAssignments: [],
    agentTelephony: [],
  };
  if (await tableExists(db, "voice_flows")) {
    data.voiceApplications = (
      await db.query(
        `SELECT id, telnyx_voice_app_id, webhook_url
           FROM voice_flows
          WHERE telnyx_voice_app_id IS NOT NULL OR webhook_url IS NOT NULL
          ORDER BY id`,
      )
    ).rows;
  }
  if (await tableExists(db, "voice_flow_phone_numbers")) {
    data.phoneAssignments = (
      await db.query(
        `SELECT flow_id, phone_number_id, phone_number
           FROM voice_flow_phone_numbers
          ORDER BY flow_id, phone_number_id`,
      )
    ).rows;
  }
  if (await tableExists(db, "users")) {
    data.agentTelephony = (
      await db.query(
        `SELECT id, telephony_credentials_id, telephony_user_name,
                voice_number, mobile
           FROM users
          WHERE telephony_credentials_id IS NOT NULL
             OR telephony_user_name IS NOT NULL
             OR voice_number IS NOT NULL
          ORDER BY id`,
      )
    ).rows;
  }
  return data;
}

async function preflightBlockers(db, git) {
  const definitions = [
    ["live_work_items", "acd_work_items", "terminal_at IS NULL"],
    ["live_legs", "acd_legs", "ended_at IS NULL"],
    ["live_reservations", "acd_reservations", "state <> 'released'"],
    ["live_direct_intents", "acd_direct_intents", "ended_at IS NULL"],
    ["live_outbound_lines", "acd_outbound_lines", "released_at IS NULL"],
    ["running_sagas", "acd_sagas", "state IN ('running', 'compensating')"],
    ["unresolved_commands", "acd_commands", "status IN ('planned', 'sent', 'ambiguous')"],
    ["unresolved_webhooks", "acd_webhook_events", "status IN ('received', 'processing', 'retryable_failed')"],
    ["running_campaigns", "outbound_campaigns", "status = 'running'"],
  ];
  const blockers = [];
  for (const [name, table, where] of definitions) {
    const count = await countRows(db, table, where);
    blockers.push({ name, count: count || 0 });
  }
  if (await tableExists(db, "acd_outbox")) {
    const materialized = await tableExists(db, "acd_stream_events");
    const result = materialized
      ? await db.query(
          `SELECT count(*)::bigint AS count
             FROM acd_outbox outbox
             LEFT JOIN acd_stream_events stream ON stream.outbox_seq = outbox.seq
            WHERE stream.outbox_seq IS NULL`,
        )
      : { rows: [{ count: await countRows(db, "acd_outbox") }] };
    blockers.push({
      name: "unmaterialized_outbox",
      count: Number(result.rows[0]?.count || 0),
    });
  }
  blockers.push({ name: "dirty_git_worktree", count: git.dirty ? 1 : 0 });
  return blockers;
}

export function computeCutoverToken(report) {
  const payload = {
    database: report.database,
    git: report.git,
    schemaFingerprint: report.schemaFingerprint,
    preserve: report.preserve,
    rowCounts: report.rowCounts,
    providerConfiguration: report.providerConfiguration,
    blockers: report.blockers,
    unknownObjects: report.catalog.unknown,
  };
  return `ACD-${sha256(stableJson(payload)).slice(0, 24).toUpperCase()}`;
}

export async function buildCutoverReport(
  db,
  { repositoryRoot = REPOSITORY_ROOT } = {},
) {
  const [databaseResult, serverResult, catalog, fingerprint] = await Promise.all([
    db.query("SELECT current_database() AS name"),
    db.query("SHOW server_version"),
    publicCatalog(db),
    schemaFingerprint(db),
  ]);
  const classifiedCatalog = classifyCatalog(catalog);
  const git = gitState(repositoryRoot);
  const preserve = {};
  for (const table of PRESERVE_CONFIGURATION) {
    preserve[table] = {
      present: await tableExists(db, table),
      count: await countRows(db, table),
      stableHash: await stableTableHash(db, table),
      excludedOperationalColumns: STABLE_HASH_EXCLUSIONS[table] || [],
    };
  }
  const rowCounts = {};
  for (const row of catalog.tables) {
    rowCounts[row.name] = await countRows(db, row.name);
  }
  const blockers = await preflightBlockers(db, git);
  const resetCandidates = {
    runningOrPausedCampaignRuns: await countRows(
      db,
      "outbound_campaign_runs",
      "status IN ('running', 'paused')",
    ),
    activeVoiceFlowExecutions: await countRows(
      db,
      "voice_flow_executions",
      "status = 'active'",
    ),
    activeGeneratorRuns: await countRows(
      db,
      "cg_runs",
      "status IN ('pending', 'running', 'stopping')",
    ),
  };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    database: databaseResult.rows[0]?.name || null,
    postgresVersion: serverResult.rows[0]?.server_version || null,
    git,
    schemaFingerprint: fingerprint,
    providerConfiguration: await providerConfiguration(db),
    preserve,
    rowCounts,
    resetCandidates,
    blockers,
    catalog: classifiedCatalog,
  };
  report.ready =
    classifiedCatalog.unknown.length === 0 &&
    blockers.every((blocker) => blocker.count === 0);
  report.cutoverToken = report.ready ? computeCutoverToken(report) : null;
  return report;
}

async function deleteRowsIfPresent(db, table) {
  if (await tableExists(db, table)) {
    await db.query(`DELETE FROM ${quoteIdentifier(table)}`);
  }
}

async function updateExistingColumns(db, table, assignments) {
  if (!(await tableExists(db, table))) return;
  const existing = [];
  for (const [column, sqlValue] of assignments) {
    if (await columnExists(db, table, column)) {
      existing.push(`${quoteIdentifier(column)} = ${sqlValue}`);
    }
  }
  if (existing.length > 0) {
    await db.query(`UPDATE ${quoteIdentifier(table)} SET ${existing.join(", ")}`);
  }
}

async function dropForeignKeysTouchingTables(db, tables) {
  const result = await db.query(
    `SELECT constraint_record.conname AS name, source.relname AS source_table
       FROM pg_constraint constraint_record
       JOIN pg_class source ON source.oid = constraint_record.conrelid
       JOIN pg_class target ON target.oid = constraint_record.confrelid
       JOIN pg_namespace namespace ON namespace.oid = source.relnamespace
      WHERE namespace.nspname = 'public'
        AND constraint_record.contype = 'f'
        AND (source.relname = ANY($1::text[]) OR target.relname = ANY($1::text[]))`,
    [tables],
  );
  for (const row of result.rows) {
    await db.query(
      `ALTER TABLE ${quoteIdentifier(row.source_table)} DROP CONSTRAINT ${quoteIdentifier(row.name)}`,
    );
  }
}

async function dropColumn(db, table, column) {
  if ((await tableExists(db, table)) && (await columnExists(db, table, column))) {
    await db.query(
      `ALTER TABLE ${quoteIdentifier(table)} DROP COLUMN ${quoteIdentifier(column)}`,
    );
  }
}

async function assertPreserved(db, before) {
  const failures = [];
  for (const table of PRESERVE_CONFIGURATION) {
    const actual = {
      present: await tableExists(db, table),
      count: await countRows(db, table),
      stableHash: await stableTableHash(db, table),
    };
    const expected = before[table];
    if (
      actual.present !== expected.present ||
      actual.count !== expected.count ||
      actual.stableHash !== expected.stableHash
    ) {
      failures.push({ table, expected, actual });
    }
  }
  if (failures.length > 0) {
    throw new Error(`Preserved configuration changed: ${JSON.stringify(failures)}`);
  }
}

export async function executeCutover(pool, expectedToken, options = {}) {
  if (!expectedToken) throw new Error("--token is required for --execute");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('acd-core-total-voice-cutover-v1'))");
    const before = await buildCutoverReport(client, options);
    if (!before.ready) {
      throw new Error("Cutover preflight is not ready; inspect the report and clear every blocker");
    }
    if (before.cutoverToken !== expectedToken) {
      throw new Error("Cutover token does not match the current database, schema, configuration and Git state");
    }

    for (const table of [
      "quality_ai_jobs",
      "quality_evaluations",
      "aa_ai_handoff_events",
      "aa_workflow_item_status",
      "aa_workflow_sessions",
      "form_submissions",
      "outbound_webhook_events",
      "outbound_attempt_ledger",
      "outbound_campaign_runs",
      "voice_flow_executions",
      "cg_commands",
      "cg_webhook_inbox",
      "cg_call_ledger",
      "cg_runs",
      "cg_runtime_state",
      "hp_local_bridge_commands",
      "hp_cti_sessions",
      "hp_provisioning_events",
      "cc_agent_status_intervals",
      "cc_user_activity_log",
      "cc_user_sessions",
    ]) {
      await deleteRowsIfPresent(client, table);
    }

    for (const table of [
      "acd_action_requests",
      "acd_transcripts",
      "acd_recordings",
      "acd_work_item_annotations",
      "acd_outbound_schedule",
      "acd_outbound_lines",
      "acd_direct_intents",
      "acd_commands",
      "acd_sagas",
      "acd_stream_events",
      "acd_outbox",
      "acd_events",
      "acd_webhook_events",
      "voice_webhook_dedupe",
      "acd_retention_watermarks",
      "acd_agent_sessions",
      "acd_agent_state",
      "acd_reservations",
      "acd_offers",
      "acd_leg_intents",
      "acd_legs",
      "acd_segments",
      "acd_work_items",
      "acd_operator_actions",
    ]) {
      await deleteRowsIfPresent(client, table);
    }

    if (await tableExists(client, "outbound_campaigns")) {
      await client.query(
        `UPDATE outbound_campaigns SET status = 'stopped'
          WHERE status IN ('running', 'paused')`,
      );
    }
    await updateExistingColumns(client, "outbound_contact_records", [
      ["last_attempt_at", "NULL"],
    ]);
    await updateExistingColumns(client, "contacts", [
      ["interaction_count", "0"],
      ["last_interaction_at", "NULL"],
    ]);
    await updateExistingColumns(client, "hp_local_bridges", [
      ["status", "'offline'"],
      ["last_seen_at", "NULL"],
    ]);
    await updateExistingColumns(client, "hp_phones", [
      ["provisioning_state", "'pending'"],
      ["last_seen_at", "NULL"],
      ["last_user_agent", "NULL"],
      ["last_ip", "NULL"],
      ["sip_registration_status", "NULL"],
    ]);

    // Compatibility triggers reference columns that the final schema removes.
    // Drop those trigger bindings before the columns; the whole sequence is
    // still protected by the serializable transaction and rolls back together.
    for (const [trigger, table] of [
      ["acd_guard_legacy_agent_projection", "acd_agent_state"],
      ["acd_webhook_assign_intake_owner", "acd_webhook_events"],
      ["acd_webhook_intake_owner_immutable", "acd_webhook_events"],
      ["acd_compat_work_item_control", "acd_work_items"],
    ]) {
      if (await tableExists(client, table)) {
        await client.query(
          `DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger)} ON ${quoteIdentifier(table)}`,
        );
      }
    }

    for (const [table, column] of [
      ["form_submissions", "interaction_id"],
      ["aa_workflow_sessions", "interaction_id"],
      ["aa_ai_handoff_events", "interaction_id"],
      ["quality_evaluations", "interaction_id"],
      ["quality_ai_jobs", "interaction_id"],
      ["cc_user_activity_log", "interaction_id"],
      ["cc_agent_status_intervals", "interaction_id"],
      ["cc_queues", "engine_owner"],
      ["acd_work_items", "engine_owner"],
      ["acd_work_items", "legacy_interaction_id"],
      ["acd_reservations", "legacy_interaction_id"],
      ["acd_reservations", "legacy_reservation_id"],
      ["acd_agent_state", "state_authority"],
      ["acd_webhook_events", "intake_owner"],
      ["acd_direct_intents", "source_interaction_id"],
      ["outbound_attempt_ledger", "acd_work_item_id"],
    ]) {
      await dropColumn(client, table, column);
    }

    await dropLegacyFunctions(client);

    await dropForeignKeysTouchingTables(client, DROP_RUNTIME);
    for (const table of DROP_RUNTIME) {
      if (await tableExists(client, table)) {
        await client.query(`DROP TABLE ${quoteIdentifier(table)}`);
      }
    }

    await ensureAcdSchema(client);
    if (await tableExists(client, "cg_runtime_state")) {
      await client.query(
        `INSERT INTO cg_runtime_state (id, heartbeat_at, node_id, last_dial_at)
         VALUES ('executor', NULL, NULL, NULL)
         ON CONFLICT (id) DO UPDATE
           SET heartbeat_at = NULL, node_id = NULL, last_dial_at = NULL`,
      );
    }
    for (const sequence of [
      "acd_events_id_seq",
      "acd_outbox_seq_seq",
      "acd_stream_events_seq_seq",
    ]) {
      const present = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [
        `public.${sequence}`,
      ]);
      if (present.rows[0]?.present) {
        await client.query(`ALTER SEQUENCE ${quoteIdentifier(sequence)} RESTART WITH 1`);
      }
    }

    await assertPreserved(client, before.preserve);
    for (const table of DROP_RUNTIME) {
      if (await tableExists(client, table)) {
        throw new Error(`Retired table still exists: ${table}`);
      }
    }
    for (const table of RESET_CORE_RUNTIME) {
      const expected = table === "acd_retention_watermarks" ? 0 : 0;
      const count = await countRows(client, table);
      if (count !== null && count !== expected) {
        throw new Error(`Core runtime table ${table} was not reset (count=${count})`);
      }
    }
    await client.query("COMMIT");
    return {
      ok: true,
      database: before.database,
      gitCommit: before.git.commit,
      preservedTables: PRESERVE_CONFIGURATION.length,
      resetCoreTables: RESET_CORE_RUNTIME.length,
      resetAuxiliaryTables: RESET_AUXILIARY_RUNTIME.length,
      droppedTables: DROP_RUNTIME.length,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function parseArgs(argv) {
  const result = { mode: "report", token: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--report") result.mode = "report";
    else if (arg === "--execute") result.mode = "execute";
    else if (arg === "--token") result.token = argv[++index] || null;
    else if (arg === "--output") result.output = argv[++index] || null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = getPostgresPool();
  if (!pool) throw new Error("PostgreSQL is not configured");
  try {
    if (args.mode === "execute") {
      const result = await executeCutover(pool, args.token);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const report = await buildCutoverReport(pool);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) writeFileSync(path.resolve(args.output), serialized);
    process.stdout.write(serialized);
    if (!report.ready) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

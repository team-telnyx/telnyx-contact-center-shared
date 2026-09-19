// Shared test-DB bootstrap for ACD Core suites. Each test FILE uses its own
// database (node --test runs files in parallel processes) and drops/recreates
// all tables for a clean slate. Returns null when PostgreSQL is unreachable —
// suites must skip cleanly in that case.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { ensureAcdSchema } from "../../lib/acd/schema.mjs";

export function readDotEnvPostgres() {
  const config = {
    host: process.env.POSTGRES_HOST || "localhost",
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER || "contact_center",
    password: process.env.POSTGRES_PASSWORD || "",
    database: process.env.POSTGRES_DB || "contact_center",
  };
  if (!config.password) {
    try {
      const env = readFileSync(new URL("../../.env", import.meta.url), "utf8");
      for (const line of env.split("\n")) {
        const match = line.match(/^POSTGRES_(HOST|PORT|USER|PASSWORD|DB)=(.*)$/);
        if (!match) continue;
        const value = match[2].trim();
        if (match[1] === "HOST" && !process.env.POSTGRES_HOST) config.host = value;
        if (match[1] === "PORT" && !process.env.POSTGRES_PORT) config.port = Number(value);
        if (match[1] === "USER" && !process.env.POSTGRES_USER) config.user = value;
        if (match[1] === "PASSWORD") config.password = value;
        if (match[1] === "DB" && !process.env.POSTGRES_DB) config.database = value;
      }
    } catch {
      /* no .env — fall through to defaults */
    }
  }
  process.env.POSTGRES_HOST ||= String(config.host);
  process.env.POSTGRES_PORT ||= String(config.port);
  process.env.POSTGRES_USER ||= String(config.user);
  process.env.POSTGRES_PASSWORD ||= String(config.password);
  process.env.POSTGRES_DB ||= String(config.database);
  return config;
}

export async function prepareAcdTestPool(testDbName) {
  const base = readDotEnvPostgres();
  let admin;
  try {
    admin = new pg.Pool({ ...base, max: 1, connectionTimeoutMillis: 2500 });
    const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [testDbName]);
    if (exists.rows.length === 0) {
      await admin.query(`CREATE DATABASE ${testDbName}`);
    }
  } catch (error) {
    if (String(process.env.ACD_TEST_ALLOW_DB_SKIP || "false").toLowerCase() === "true") {
      return null;
    }
    throw new Error(
      `ACD PostgreSQL test bootstrap failed for ${base.host}:${base.port}/${base.database}: ${error?.code || error?.message || "unknown error"}`,
      { cause: error },
    );
  } finally {
    await admin?.end().catch(() => {});
  }

  const pool = new pg.Pool({
    ...base,
    database: testDbName,
    max: 8,
    connectionTimeoutMillis: 2500,
  });
  const client = await pool.connect();
  try {
    await client.query(`
      DROP TABLE IF EXISTS acd_sla_measurements, cc_sla_policy_audit, form_submissions, aa_ai_handoff_events,
        quality_ai_jobs, quality_evaluations, aa_workflow_sessions CASCADE;
      DROP TABLE IF EXISTS acd_work_item_annotations, acd_transcripts, acd_recordings,
        acd_action_requests, acd_outbound_lines, acd_direct_intents, acd_test_provider_calls, acd_stream_events, acd_retention_watermarks, acd_operator_actions, acd_outbox, acd_webhook_events, acd_events, acd_commands,
        acd_sagas, acd_agent_sessions, acd_agent_state, acd_reservations, acd_offers,
        acd_leg_intents, acd_legs, acd_segments, acd_work_items CASCADE;
      DROP TABLE IF EXISTS cc_agent_status_intervals,
        acd_text_attachments, cc_widget_handoffs, cc_widget_handoff_integration, cc_widget_ai_commands, cc_widget_sessions, cc_widget_preview_assets, cc_widget_audit, cc_widget_revisions, cc_widgets,
        cc_email_compose_requests, cc_email_audit, cc_email_drafts, cc_email_deliveries, cc_email_messages, cc_email_threads, cc_email_received, cc_email_mailboxes,
        cc_sms_audit, cc_sms_templates, cc_sms_messages, cc_sms_threads, cc_sms_received, cc_sms_numbers, cc_sms_profiles,
        cc_whatsapp_audit, cc_whatsapp_messages, cc_whatsapp_threads, cc_whatsapp_media, cc_whatsapp_received, cc_whatsapp_numbers, cc_whatsapp_profiles, cc_whatsapp_accounts,
        acd_video_sessions, cc_video_media, acd_chat_copilot_requests, acd_text_commands, acd_text_drafts, acd_text_assignments, acd_messages, acd_conversations,
        cc_agent_queue_channels, cc_queue_channels, cc_agent_channel_policies, cc_agent_utilization,
        cc_user_activity_log, cc_user_statuses,
        cc_queue_user_assignments, cc_queues, contacts, users CASCADE;
    `);
    // Minimal mirrors of the configuration and reporting tables used by Core.
    await client.query(`
      DROP TABLE IF EXISTS skills CASCADE;
      CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, is_active BOOLEAN DEFAULT true);
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        profile_picture_uri TEXT,
        skills JSONB DEFAULT '{}',
        max_concurrent_calls INT DEFAULT 1,
        telephony_user_name TEXT,
        telephony_credentials_id TEXT,
        voice_number TEXT,
        mobile TEXT,
        available_for_routing BOOLEAN DEFAULT true,
        roles TEXT[] DEFAULT ARRAY['agent']::TEXT[],
        notification_sounds JSONB
      );
      CREATE TABLE cc_queues (
        id TEXT PRIMARY KEY,
        name TEXT,
        display_name TEXT,
        enabled BOOLEAN DEFAULT true,
        routing_strategy TEXT DEFAULT 'FIFO',
        skill_requirements JSONB DEFAULT '{}',
        skill_relaxation_enabled BOOLEAN DEFAULT false,
        skill_relaxation_after_seconds INT DEFAULT 60,
        skill_relaxation_strategy TEXT DEFAULT 'progressive',
        agent_answer_timeout_secs INT DEFAULT 20,
        queue_audio_media_name TEXT
      );
      CREATE TABLE cc_queue_user_assignments (
        queue_id TEXT, user_id TEXT, enabled BOOLEAN DEFAULT true,
        priority INT DEFAULT 0, activated_at TIMESTAMPTZ DEFAULT now(), deactivated_at TIMESTAMPTZ
      );
      CREATE TABLE cc_user_statuses (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('active', 'break')),
        is_active BOOLEAN DEFAULT true
      );
      INSERT INTO cc_user_statuses (id, name, type) VALUES
        ('available', 'Available', 'active'),
        ('busy', 'Busy', 'active'),
        ('break', 'Break', 'break'),
        ('wrapup', 'Wrapup', 'break'),
        ('offline', 'Offline', 'active'),
        ('agent-not-answering', 'Agent Not Answering', 'active');
      CREATE TABLE cc_user_activity_log (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL,
        activity_value TEXT,
        previous_value TEXT,
        metadata JSONB DEFAULT '{}'::jsonb,
        queue_id TEXT,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        duration_seconds INTEGER,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE cc_agent_status_intervals (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        agent_username TEXT,
        status TEXT NOT NULL,
        status_type TEXT NOT NULL,
        next_status TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ NOT NULL,
        duration_seconds INTEGER NOT NULL,
        source TEXT NOT NULL,
        source_event_id TEXT,
        work_item_id TEXT,
        reason TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        first_name TEXT,
        last_name TEXT,
        phone TEXT,
        mobile TEXT,
        business_phone_1 TEXT,
        business_phone_2 TEXT,
        home_phone_1 TEXT,
        home_phone_2 TEXT,
        last_interaction_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now(),
        deleted_at TIMESTAMPTZ
      );
    `);
    await ensureAcdSchema(client);
  } finally {
    client.release();
  }
  return pool;
}

export function makeTxRunner(pool) {
  return async function withTx(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
}

export async function seedAgent(pool, agentId, overrides = {}) {
  await pool.query(
    `INSERT INTO users (id, username, first_name, skills, telephony_user_name, telephony_credentials_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (id) DO UPDATE SET skills = EXCLUDED.skills`,
    [
      agentId,
      overrides.username || `${agentId}@test.local`,
      overrides.firstName || agentId,
      JSON.stringify(overrides.skills || {}),
      overrides.telephonyUserName || agentId,
      overrides.credentialsId || `cred-${agentId}`,
    ],
  );
  await pool.query(
    `INSERT INTO acd_agent_state (agent_id, presence, routability, workflow_state, capacity)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (agent_id) DO UPDATE SET presence = $2, routability = $3,
       workflow_state = $4, capacity = $5, workflow_deadline_at = NULL`,
    [
      agentId,
      overrides.presence || "online",
      overrides.routability || "routable",
      overrides.workflowState || "idle",
      overrides.capacity ?? 1.0,
    ],
  );
  const sessionId = overrides.sessionId || randomUUID();
  if ((overrides.presence || "online") === "online" && overrides.voiceReady !== false) {
    await pool.query(
      `INSERT INTO acd_agent_sessions
         (id, agent_id, node_id, device_id, capabilities, state, heartbeat_at, expires_at)
       VALUES ($1, $2, 'test', 'test-browser', '{"voice":true}'::jsonb,
               'online', now(), now() + interval '5 minutes')`,
      [sessionId, agentId],
    );
  }
  return { sessionId };
}

export async function seedQueue(pool, queueId, agentIds, overrides = {}) {
  await pool.query(
    `INSERT INTO cc_queues (id, name, routing_strategy, agent_answer_timeout_secs)
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE
       SET name = $2, routing_strategy = $3, agent_answer_timeout_secs = $4`,
    [
      queueId,
      overrides.name || queueId,
      overrides.strategy || "FIFO",
      overrides.answerTimeout ?? 20,
    ],
  );
  for (const agentId of agentIds) {
    await pool.query(
      `INSERT INTO cc_queue_user_assignments (queue_id, user_id, priority) VALUES ($1, $2, $3)`,
      [queueId, agentId, overrides.priority ?? 0],
    );
  }
}

/**
 * Scriptable provider for saga tests. `script` is an array of outcomes
 * consumed per send: {outcome:'accepted'|'failed'|'ambiguous', httpStatus, response}.
 * When the script is empty, defaults to accepted/200. Records every call.
 */
export function makeFakeProvider(script = []) {
  const calls = [];
  return {
    name: "fake",
    calls,
    async send({ endpoint, request, commandId, operation }) {
      calls.push({ endpoint, request, commandId, operation });
      // Media-stop commands are prerequisite hygiene, not the business effect
      // most saga tests script (transfer/enqueue/hangup). Do not consume the
      // next scripted outcome for them.
      const next = [
        "stop_queue_playback",
        "consult_release_source_agent",
        "consult_start_customer_hold_audio",
        "consult_speak_customer_hold_announcement",
        "consult_start_consultant_hold_audio",
        "consult_speak_consultant_hold_announcement",
        "consult_stop_consultant_hold_audio",
        "consult_pause_consultant_hold_audio",
        "consult_resume_consultant_hold_audio",
        "agent_hold_speak_announcement",
        "agent_hold_start_music",
        "agent_hold_pause_music",
        "agent_hold_stop_audio",
      ].includes(operation)
        ? null
        : script.shift();
      if (!next) return { outcome: "accepted", httpStatus: 200, response: { data: { result: "ok" } } };
      return { httpStatus: 200, response: {}, ...next };
    },
  };
}

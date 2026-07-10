import { createDiagnosticLogger } from "./diagnostic-logger.mjs";
import { getPostgresPool } from "./postgres.mjs";
import { SEEDED_DEFAULT_QUEUE_TEMPLATE } from "./seeded-default-queue-template.mjs";

const seedLogger = createDiagnosticLogger("platform.app");

// Fixed, well-known ID for the seeded "Sales" queue — same rationale as
// lib/seed-default-call-flow.mjs's SEEDED_DEFAULT_FLOW_ID: every deployment
// (local docker AND cloud) ends up with the exact same row id, so re-runs
// (container restart, `cc update`, a second ensurePostgresSchema() call)
// always find the same row instead of creating a new one, and so any future
// code that needs a stable reference to "the seeded queue" (the way
// SEEDED_DEFAULT_FLOW_ID is referenced from telnyx-bootstrap-orchestrator.mjs)
// has one available. NOT currently referenced by the Default Call Flow
// itself, though — see lib/default-call-flow-template.mjs's header comment:
// the flow's `enqueue` node targets this queue by NAME (queue_name: "Sales"),
// a plain string lookup against cc_queues.name at call time, same as the
// Telnyx Call Control enqueue API itself takes a queue name, not an id. This
// id exists for internal consistency (every other seeded row in this app has
// one) and any tooling that wants to detect "has the queue seed already run"
// without a name-based lookup.
export const SEEDED_DEFAULT_QUEUE_ID = "00000000-cc00-4000-8000-000000000002";

/**
 * Seeds the "Sales" queue (+ its wrapup-code assignments) into `cc_queues` /
 * `cc_queue_wrapup_codes`.
 *
 * Runs on every app boot (called from ensurePostgresSchema(), same as
 * seed-default-call-flow.mjs) — for BOTH the Local target and every cloud
 * target, since the app is always running right next to its own database
 * wherever it's deployed. Must run BEFORE seed-default-call-flow.mjs in
 * ensurePostgresSchema()'s call order so a Telnyx test call placed the
 * instant the app comes up can already resolve the "Sales" queue_name
 * lookup the seeded flow's enqueue node depends on — though in practice
 * either order is safe since the name-based lookup happens at CALL time,
 * long after both seeds have run.
 *
 * Idempotent: ON CONFLICT (id) DO NOTHING on cc_queues preserves any in-app
 * edits the user has made to the seeded queue (routing strategy, hold audio,
 * etc.); the wrapup-code assignment inserts are ON CONFLICT DO NOTHING per
 * (queue_id, wrapup_code_id) pair, safe to repeat on every boot.
 *
 * Deliberately does NOT talk to the Telnyx API — the queue's hold-audio
 * media file ("spring_field") is uploaded earlier, during Telnyx
 * provisioning (see deploy/cli/lib/telnyx-media.mjs, wired into
 * ensureCoreTelnyxObjects), for the same reason the Default Call Flow's
 * voice app is created there rather than here: that step runs on the
 * OPERATOR's machine where Telnyx's public API is always reachable, unlike
 * Postgres for cloud targets. This module only owns the DB-side rows.
 */
export async function seedDefaultQueue() {
  try {
    const pool = getPostgresPool();
    if (!pool) {
      seedLogger.error("seed_queue_db_unavailable");
      return false;
    }

    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = '5s'");

      const existing = await client.query(
        "SELECT id FROM cc_queues WHERE id = $1",
        [SEEDED_DEFAULT_QUEUE_ID]
      );

      if (existing.rows.length === 0) {
        const t = SEEDED_DEFAULT_QUEUE_TEMPLATE;

        // Case-insensitive name collision check — cc_queues.name has a
        // case-SENSITIVE UNIQUE constraint (see postgres-schema.mjs), but
        // every name-based LOOKUP in the app (PgDb.findQueueByName,
        // lib/contact-center/queue-utils.js's resolveQueueName) is
        // case-INSENSITIVE (matches Telnyx's own shared-queue convention
        // of uppercase names — SALES/SUPPORT/MARKETING, see
        // queue-utils.js's SHARED_QUEUES). Without this check, an admin
        // who already created a queue named "SALES" by hand (e.g. via
        // Admin > Queues, using the canonical uppercase convention the
        // Enqueue node editor's own dropdown suggests) would end up with
        // BOTH "SALES" and this seed's "Sales" as two distinct rows —
        // Postgres's case-sensitive UNIQUE constraint allows it, but every
        // case-insensitive lookup afterward would non-deterministically
        // match either row, silently losing this seed's audio/wrapup-code
        // configuration on some fraction of calls. If a same-name queue
        // already exists under ANY casing, skip creating a new one
        // entirely rather than risk this split-brain state.
        const nameCollision = await client.query(
          "SELECT id, name FROM cc_queues WHERE UPPER(name) = UPPER($1) AND id != $2",
          [t.name, SEEDED_DEFAULT_QUEUE_ID]
        );
        if (nameCollision.rows.length > 0) {
          seedLogger.warn("seed_queue_name_collision_skipped");
          return true;
        }

        await client.query(
          `INSERT INTO cc_queues (
            id, name, display_name, description,
            routing_strategy, max_wait_time_secs, max_size, timeout_secs,
            overflow_action, priority, enabled, active,
            skill_requirements, priority_rules,
            queue_audio_media_name, queue_audio_enable_position,
            queue_audio_position_interval_secs, queue_audio_tts_voice,
            agent_answer_timeout_secs, default_call_priority,
            sla_answer_threshold_seconds, sla_target_percentage,
            avg_handle_time_seconds,
            created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20, $21, $22, $23, NOW(), NOW()
          )
          ON CONFLICT (id) DO NOTHING`,
          [
            SEEDED_DEFAULT_QUEUE_ID,
            t.name,
            t.displayName,
            t.description,
            t.routingStrategy,
            t.maxWaitTimeSecs,
            t.maxSize,
            t.timeoutSecs,
            t.overflowAction,
            t.priority,
            t.enabled,
            t.active,
            JSON.stringify(t.skillRequirements || {}),
            JSON.stringify(t.priorityRules || []),
            t.queueAudioMediaName,
            t.queueAudioEnablePosition,
            t.queueAudioPositionIntervalSecs,
            t.queueAudioTtsVoice,
            t.agentAnswerTimeoutSecs,
            t.defaultCallPriority,
            t.slaAnswerThresholdSeconds,
            t.slaTargetPercentage,
            t.avgHandleTimeSeconds,
          ]
        );
        seedLogger.info("seed_queue_created");

        // Wrapup-code assignments — only meaningful right after the queue
        // itself was just created (ON CONFLICT above means this whole
        // branch is skipped entirely on repeat boots, same as the call
        // flow seed's existing-row short-circuit). Each id is checked
        // against cc_wrapup_codes first rather than relying on the
        // INSERT's FK constraint to fail silently-per-row, since a
        // multi-row VALUES insert would abort entirely on the first
        // missing id otherwise.
        const wrapupIds = t.wrapupCodeIds || [];
        if (wrapupIds.length > 0) {
          const known = await client.query(
            "SELECT id FROM cc_wrapup_codes WHERE id = ANY($1::text[])",
            [wrapupIds]
          );
          const knownIds = new Set(known.rows.map((r) => r.id));
          const missing = wrapupIds.filter((id) => !knownIds.has(id));
          if (missing.length > 0) {
            seedLogger.warn("seed_queue_wrapup_codes_missing");
          }
          for (const wrapupId of wrapupIds) {
            if (!knownIds.has(wrapupId)) continue;
            // eslint-disable-next-line no-await-in-loop -- small fixed list (17 rows), sequential is fine and keeps error handling per-row.
            await client.query(
              `INSERT INTO cc_queue_wrapup_codes (id, queue_id, wrapup_code_id, created_at, updated_at)
               VALUES (gen_random_uuid()::text, $1, $2, NOW(), NOW())
               ON CONFLICT (queue_id, wrapup_code_id) DO NOTHING`,
              [SEEDED_DEFAULT_QUEUE_ID, wrapupId]
            );
          }
          seedLogger.info("seed_queue_wrapup_codes_linked");
        }
      } else {
        seedLogger.info("seed_queue_exists");
      }

      return true;
    } finally {
      try {
        await client.query("RESET statement_timeout");
      } catch {
        // Ignore reset errors
      }
      client.release();
    }
  } catch (error) {
    if (error.code === "57014") {
      seedLogger.info("seed_queue_timeout");
    } else {
      seedLogger.error("seed_queue_failed");
    }
    return false;
  }
}

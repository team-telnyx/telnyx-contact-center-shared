import { saveAdminSettings } from "@/lib/acd/utilization.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { queueScopeSql } from "@/lib/authz/scope.mjs";


async function GET_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ rows: [], count: 0 });

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const pageSize = Math.min(
    100,
    Math.max(1, Number(searchParams.get("pageSize") || 20)),
  );
  const offset = (page - 1) * pageSize;

  const where = [];
  const vals = [];
  let i = 1;
  const q = searchParams.get("q");
  const routingStrategy = searchParams.get("routingStrategy");
  const enabled = searchParams.get("enabled");

  if (q) {
    where.push(
      `(name ILIKE $${i} OR display_name ILIKE $${i} OR description ILIKE $${i})`,
    );
    vals.push(`%${q}%`);
    i += 1;
  }
  if (routingStrategy && routingStrategy !== "all") {
    where.push(`routing_strategy=$${i}`);
    vals.push(routingStrategy);
    i += 1;
  }
  if (enabled === "true" || enabled === "false") {
    where.push(`enabled=$${i}`);
    vals.push(enabled === "true");
    i += 1;
  }
  // Queue scope of the granting roles (Phase 3a).
  where.push(...queueScopeSql(authz.scope, "id", vals));
  i = vals.length + 1;

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rowsSql = `SELECT id, name, display_name, description, routing_strategy, max_wait_time_secs, max_size, timeout_secs, overflow_queue_id, overflow_action, priority, enabled, active, created_at, updated_at FROM cc_queues ${whereSql} ORDER BY priority DESC, name ASC LIMIT ${pageSize} OFFSET ${offset}`;
  const [rowsRes, countRes] = await Promise.all([
    pool.query(rowsSql, vals),
    pool.query(`SELECT COUNT(*) AS c FROM cc_queues ${whereSql}`, vals),
  ]);
  return NextResponse.json({
    rows: rowsRes.rows || [],
    count: Number(countRes.rows?.[0]?.c || 0),
  });
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const body = await request.json();
  if (Array.isArray(body.userAssignments) && body.userAssignments.length && !authz.can("queues:agents.assign")) {
    return NextResponse.json({ error: "Forbidden", permission: "queues:agents.assign" }, { status: 403 });
  }
  const name = String(body.name || "").trim();
  if (!name)
    return NextResponse.json({ error: "name required" }, { status: 400 });

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  try {
    const saved = await saveAdminSettings(pool, { scope: "queue", create: true, utilization: body.utilization, actor: String(user.id) }, async (pool, afterCommit) => {
    const id = await PgDb.insertQueue({
      name,
      displayName: body.displayName || null,
      description: body.description || null,
      routingStrategy: body.routingStrategy || "FIFO",
      maxWaitTimeSecs: body.maxWaitTimeSecs || 600,
      maxSize: body.maxSize || 100,
      timeoutSecs: body.timeoutSecs || 300,
      agentAnswerTimeoutSecs:
        body.agentAnswerTimeoutSecs == null || body.agentAnswerTimeoutSecs === ""
          ? null
          : Number(body.agentAnswerTimeoutSecs),
      overflowQueueId: body.overflowQueueId || null,
      overflowAction: body.overflowAction || "transfer",
      priority: body.priority || 0,
      enabled: body.enabled !== undefined ? body.enabled : true,
      skillRequirements: body.skillRequirements || {},
      priorityRules: body.priorityRules || [],
    }, pool);

    // Update queue audio settings if provided
    if (
      body.queueAudioMediaName !== undefined ||
      body.queueAudioEnablePosition !== undefined ||
      body.queueAudioPositionIntervalSecs !== undefined ||
      body.queueAudioTtsVoice !== undefined ||
      body.queueAudioTtsVoiceApiKeyRef !== undefined
    ) {
      const updateFields = [];
      const updateValues = [];
      let paramIndex = 1;

      if (body.queueAudioMediaName !== undefined) {
        updateFields.push(`queue_audio_media_name=$${paramIndex++}`);
        updateValues.push(
          body.queueAudioMediaName
            ? String(body.queueAudioMediaName).trim()
            : null,
        );
      }
      if (body.queueAudioEnablePosition !== undefined) {
        updateFields.push(`queue_audio_enable_position=$${paramIndex++}`);
        updateValues.push(Boolean(body.queueAudioEnablePosition));
      }
      if (body.queueAudioPositionIntervalSecs !== undefined) {
        updateFields.push(
          `queue_audio_position_interval_secs=$${paramIndex++}`,
        );
        updateValues.push(Number(body.queueAudioPositionIntervalSecs));
      }
      if (body.queueAudioTtsVoice !== undefined) {
        updateFields.push(`queue_audio_tts_voice=$${paramIndex++}`);
        updateValues.push(
          body.queueAudioTtsVoice
            ? String(body.queueAudioTtsVoice).trim()
            : null,
        );
      }
      if (body.queueAudioTtsVoiceApiKeyRef !== undefined) {
        updateFields.push(`queue_audio_tts_voice_api_key_ref=$${paramIndex++}`);
        updateValues.push(
          body.queueAudioTtsVoiceApiKeyRef
            ? String(body.queueAudioTtsVoiceApiKeyRef).trim()
            : null,
        );
      }

      if (updateFields.length > 0) {
        updateFields.push(`updated_at=$${paramIndex++}`);
        updateValues.push(new Date().toISOString());
        updateValues.push(id);
        await pool.query(
          `UPDATE cc_queues SET ${updateFields.join(", ")} WHERE id=$${paramIndex}`,
          updateValues,
        );
      }
    }

    // Update new routing engine fields if provided
    if (
      body.defaultCallPriority !== undefined ||
      body.skillRelaxationEnabled !== undefined ||
      body.skillRelaxationAfterSeconds !== undefined ||
      body.skillRelaxationStrategy !== undefined ||
      body.slaAnswerThresholdSeconds !== undefined ||
      body.slaTargetPercentage !== undefined
    ) {
      const updateFields = [];
      const updateValues = [];
      let paramIndex = 1;

      if (body.defaultCallPriority !== undefined) {
        updateFields.push(`default_call_priority=$${paramIndex++}`);
        updateValues.push(Number(body.defaultCallPriority));
      }
      if (body.skillRelaxationEnabled !== undefined) {
        updateFields.push(`skill_relaxation_enabled=$${paramIndex++}`);
        updateValues.push(Boolean(body.skillRelaxationEnabled));
      }
      if (body.skillRelaxationAfterSeconds !== undefined) {
        updateFields.push(`skill_relaxation_after_seconds=$${paramIndex++}`);
        updateValues.push(Number(body.skillRelaxationAfterSeconds));
      }
      if (body.skillRelaxationStrategy !== undefined) {
        updateFields.push(`skill_relaxation_strategy=$${paramIndex++}`);
        updateValues.push(String(body.skillRelaxationStrategy));
      }
      if (body.slaAnswerThresholdSeconds !== undefined) {
        updateFields.push(`sla_answer_threshold_seconds=$${paramIndex++}`);
        updateValues.push(Number(body.slaAnswerThresholdSeconds));
      }
      if (body.slaTargetPercentage !== undefined) {
        updateFields.push(`sla_target_percentage=$${paramIndex++}`);
        updateValues.push(Number(body.slaTargetPercentage));
      }

      if (updateFields.length > 0) {
        updateFields.push(`updated_at=$${paramIndex++}`);
        updateValues.push(new Date().toISOString());
        updateValues.push(id);
        await pool.query(
          `UPDATE cc_queues SET ${updateFields.join(", ")} WHERE id=$${paramIndex}`,
          updateValues,
        );
      }
    }

    // Add user assignments if provided
    if (body.userAssignments && Array.isArray(body.userAssignments)) {
      const { randomUUID } = await import("crypto");
      for (const assignment of body.userAssignments) {
        if (assignment.userId && assignment.enabled) {
          await pool.query(
            `INSERT INTO cc_queue_user_assignments (id, queue_id, user_id, priority, enabled, activated_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NOW())
             ON CONFLICT (queue_id, user_id) DO UPDATE SET
               priority=EXCLUDED.priority,
               enabled=EXCLUDED.enabled,
               activated_at=CASE WHEN EXCLUDED.enabled THEN NOW() ELSE cc_queue_user_assignments.activated_at END,
               deactivated_at=CASE WHEN NOT EXCLUDED.enabled THEN NOW() ELSE cc_queue_user_assignments.deactivated_at END,
               updated_at=NOW()`,
            [
              randomUUID(),
              id,
              assignment.userId,
              assignment.priority || 0,
              assignment.enabled !== undefined ? assignment.enabled : true,
            ],
          );
        }
      }
    }

    // Add wrapup code assignments if provided
    if (body.wrapupCodes && Array.isArray(body.wrapupCodes)) {
      const { randomUUID } = await import("crypto");
      for (const wrapupCodeId of body.wrapupCodes) {
        if (!wrapupCodeId) continue;
        await pool.query(
          `INSERT INTO cc_queue_wrapup_codes (id, queue_id, wrapup_code_id, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (queue_id, wrapup_code_id) DO NOTHING`,
          [randomUUID(), id, wrapupCodeId],
        );
      }
    }

    // Broadcast queue created event to all agent users
    try {
      const { broadcastToAllAgents } = await import("@/lib/sse");
      const queueRes = await pool.query(
        `SELECT * FROM cc_queues WHERE id = $1`,
        [id],
      );
      const queue = queueRes.rows?.[0];
      if (queue) {
        afterCommit.push(() => broadcastToAllAgents(
          {
            type: "queue_created",
            queue: {
              id: queue.id,
              name: queue.name,
              displayName: queue.display_name || queue.name,
              routingStrategy: queue.routing_strategy,
              enabled: queue.enabled,
            },
            timestamp: new Date().toISOString(),
          },
          "queue_changed",
        ));
      }
    } catch (sseError) {
      adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      // Don't fail the request if SSE fails
    }

    return { id };
    });
    return NextResponse.json({ ok: true, id: saved.id });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ error: msg }, { status: err.status || 400 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("queues:read", GET_handler, { route: "/api/admin/queues" });
export const POST = withPermission("queues:create", POST_handler, { route: "/api/admin/queues" });

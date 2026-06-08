import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

const TERMINAL_STATES = [
  "completed",
  "abandoned",
  "hangup",
  "ended",
  "destroy",
  "idle",
  "terminated",
  "disconnected",
  "failed",
];

const ACTIVE_STATES = [
  "queued",
  "ringing",
  "answered",
  "connected",
  "active",
  "bridging",
  "hold",
  "transferring",
  "initiated",
];

function safeParse(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 }
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Number(searchParams.get("page") || 1));
    const pageSize = Math.min(
      100,
      Math.max(1, Number(searchParams.get("pageSize") || 25))
    );
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const queueName = searchParams.get("queue");
    const agentUsername = searchParams.get("agent");
    const summaryOnly = searchParams.get("summary") === "true"; // summary=true enables Statistics range aggregates

    const where = [
      "i.is_contact_center = true",
      "COALESCE(i.metadata->>'is_transfer_leg', 'false') <> 'true'",
      "COALESCE(i.metadata->>'is_consult_call', 'false') <> 'true'",
      `(
        i.completed_at IS NOT NULL
        OR i.abandoned_at IS NOT NULL
        OR i.state = ANY($1)
        OR (i.state IS NOT NULL AND i.state <> ALL($2))
      )`,
    ];
    const vals = [TERMINAL_STATES, ACTIVE_STATES];
    let paramIndex = 3;

    if (from) {
      where.push(
        `COALESCE(i.completed_at, i.abandoned_at, i.created_at) >= $${paramIndex++}`
      );
      vals.push(from);
    }
    if (to) {
      where.push(
        `COALESCE(i.completed_at, i.abandoned_at, i.created_at) <= $${paramIndex++}`
      );
      vals.push(to);
    }
    if (queueName) {
      where.push(`i.queue_name = $${paramIndex++}`);
      vals.push(queueName);
    }
    if (agentUsername) {
      where.push(`i.agent_username = $${paramIndex++}`);
      vals.push(agentUsername);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    if (summaryOnly) {
      const callsQuery = `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE i.state = 'completed')::int AS answered,
          COUNT(*) FILTER (WHERE i.state = 'abandoned')::int AS abandoned,
          AVG(i.wait_time_seconds)::NUMERIC(10,2) AS avg_wait_time_seconds,
          AVG(i.handle_time_seconds)::NUMERIC(10,2) AS avg_handle_time_seconds,
          AVG(i.talk_time_seconds)::NUMERIC(10,2) AS avg_talk_time_seconds
        FROM cc_interactions i
        ${whereSql}
      `;
      const dailyQuery = `
        SELECT
          DATE(COALESCE(i.completed_at, i.abandoned_at, i.created_at)) AS day,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE i.state = 'completed')::int AS answered,
          COUNT(*) FILTER (WHERE i.state = 'abandoned')::int AS abandoned,
          AVG(i.wait_time_seconds)::NUMERIC(10,2) AS avg_wait_time_seconds
        FROM cc_interactions i
        ${whereSql}
        GROUP BY DATE(COALESCE(i.completed_at, i.abandoned_at, i.created_at))
        ORDER BY DATE(COALESCE(i.completed_at, i.abandoned_at, i.created_at)) ASC
      `;
      const queuesQuery = `
        SELECT
          COALESCE(i.queue_name, 'No queue') AS queue_name,
          COUNT(*)::int AS total,
          AVG(i.wait_time_seconds)::NUMERIC(10,2) AS avg_wait_time_seconds
        FROM cc_interactions i
        ${whereSql}
        GROUP BY COALESCE(i.queue_name, 'No queue')
        ORDER BY total DESC
        LIMIT 12
      `;

      const [callsRes, dailyRes, queuesRes] = await Promise.all([
        pool.query(callsQuery, vals),
        pool.query(dailyQuery, vals),
        pool.query(queuesQuery, vals),
      ]);
      const calls = callsRes.rows?.[0] || {};
      return NextResponse.json({
        ok: true,
        summary: {
          calls: {
            total: Number(calls.total || 0),
            answered: Number(calls.answered || 0),
            abandoned: Number(calls.abandoned || 0),
          },
          durations: {
            avgWaitTimeSeconds: Number(calls.avg_wait_time_seconds || 0),
            avgHandleTimeSeconds: Number(calls.avg_handle_time_seconds || 0),
            avgTalkTimeSeconds: Number(calls.avg_talk_time_seconds || 0),
          },
          daily: dailyRes.rows.map((row) => ({
            day: row.day,
            label: new Date(row.day).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
            total: Number(row.total || 0),
            answered: Number(row.answered || 0),
            abandoned: Number(row.abandoned || 0),
            avgWaitTimeSeconds: Number(row.avg_wait_time_seconds || 0),
          })),
          queues: queuesRes.rows.map((row) => ({
            queueName: row.queue_name,
            total: Number(row.total || 0),
            avgWaitTimeSeconds: Number(row.avg_wait_time_seconds || 0),
          })),
        },
      });
    }

    const offset = (page - 1) * pageSize;

    const query = `
      SELECT
        i.*,
        u.first_name,
        u.last_name
      FROM cc_interactions i
      LEFT JOIN users u ON i.agent_username = u.username
      ${whereSql}
      ORDER BY COALESCE(i.completed_at, i.abandoned_at, i.created_at) DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    const countQuery = `
      SELECT COUNT(*) AS c
      FROM cc_interactions i
      ${whereSql}
    `;
    const [rowsRes, countRes] = await Promise.all([
      pool.query(query, [...vals, pageSize, offset]),
      pool.query(countQuery, vals),
    ]);

    const rows = rowsRes.rows.map((row) => ({
      ...row,
      agent_name:
        row.first_name || row.last_name
          ? `${row.first_name || ""} ${row.last_name || ""}`.trim()
          : row.agent_username || null,
      required_skills: safeParse(row.required_skills),
      routing_metadata: safeParse(row.routing_metadata),
      transfer_history: safeParse(row.transfer_history),
      tags: safeParse(row.tags),
      metadata: safeParse(row.metadata),
    }));

    const [queuesRes, agentsRes] = await Promise.all([
      pool.query(
        `SELECT DISTINCT queue_name
         FROM cc_interactions
         WHERE queue_name IS NOT NULL
         ORDER BY queue_name ASC`
      ),
      pool.query(
        `SELECT DISTINCT u.username, u.first_name, u.last_name
         FROM users u
         JOIN cc_interactions i ON i.agent_username = u.username
         WHERE i.agent_username IS NOT NULL
         ORDER BY u.username ASC`
      ),
    ]);

    return NextResponse.json({
      ok: true,
      rows,
      count: Number(countRes.rows?.[0]?.c || 0),
      filters: {
        queues: queuesRes.rows.map((row) => row.queue_name),
        agents: agentsRes.rows.map((row) => ({
          username: row.username,
          name:
            row.first_name || row.last_name
              ? `${row.first_name || ""} ${row.last_name || ""}`.trim()
              : row.username,
        })),
      },
    });
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: "Failed to fetch call history" },
      { status: 500 }
    );
  }
}


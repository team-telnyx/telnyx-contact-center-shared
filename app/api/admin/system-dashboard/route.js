import { NextResponse } from "next/server";

import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { isAdmin } from "@/lib/role-utils";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

const RANGE_CONFIG = {
  "24h": { unit: "hour", span: "23 hours", step: "1 hour" },
  "7d": { unit: "day", span: "6 days", step: "1 day" },
  "30d": { unit: "day", span: "29 days", step: "1 day" },
};

async function safeQuery(pool, sql, params = [], fallback = []) {
  try {
    const result = await pool.query(sql, params);
    return result.rows || fallback;
  } catch (error) {
    adminRuntimeLogger.warn("system_dashboard_query_failed", {
      ...runtimePayload({ error }),
    });
    return fallback;
  }
}

async function countTable(pool, table, detailSql = "") {
  const rows = await safeQuery(
    pool,
    `SELECT COUNT(*)::int AS total ${detailSql} FROM ${table}`,
    [],
    [{ total: null }],
  );
  return rows[0] || { total: null };
}

function formatBucket(value, range) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (range === "24h") {
    return new Intl.DateTimeFormat("en", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(date);
}

async function loadTelnyxSummary() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    return {
      status: "not_configured",
      ready: false,
      detail: "TELNYX_API_KEY is not configured",
      numbers: null,
      assistants: null,
    };
  }

  const request = (url) =>
    fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

  try {
    const [numbersResult, assistantsResult] = await Promise.allSettled([
      request(buildTelnyxV2Url("/phone_numbers?page[size]=1&page[number]=1")),
      request(buildTelnyxV2Url("/ai/assistants")),
    ]);

    const numbersResponse = numbersResult.status === "fulfilled" ? numbersResult.value : null;
    const assistantsResponse = assistantsResult.status === "fulfilled" ? assistantsResult.value : null;
    const numbersData = numbersResponse?.ok ? await numbersResponse.json() : null;
    const assistantsData = assistantsResponse?.ok ? await assistantsResponse.json() : null;
    const numbers =
      numbersData?.meta?.total_results ??
      numbersData?.meta?.total_count ??
      numbersData?.meta?.total ??
      (Array.isArray(numbersData?.data) ? numbersData.data.length : null);
    const assistants = Array.isArray(assistantsData?.data)
      ? assistantsData.data.length
      : null;
    const ready = Boolean(numbersResponse?.ok && assistantsResponse?.ok);

    return {
      status: ready ? "connected" : "degraded",
      ready,
      detail: ready
        ? "Voice and AI APIs are reachable"
        : "One or more Telnyx APIs are unavailable",
      numbers,
      assistants,
    };
  } catch (error) {
    adminRuntimeLogger.warn("system_dashboard_telnyx_check_failed", {
      ...runtimePayload({ error }),
    });
    return {
      status: "disconnected",
      ready: false,
      detail: "Telnyx API check failed",
      numbers: null,
      assistants: null,
    };
  }
}

export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user || !isAdmin(user)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const rangeParam = new URL(request.url).searchParams.get("range") || "24h";
    const range = RANGE_CONFIG[rangeParam] ? rangeParam : "24h";
    const config = RANGE_CONFIG[range];
    const pool = getPostgresPool();
    const telnyxPromise = loadTelnyxSummary();

    if (!pool) {
      const telnyx = await telnyxPromise;
      return NextResponse.json(
        {
          ok: true,
          range,
          generatedAt: new Date().toISOString(),
          inventory: {
            users: null,
            queues: null,
            skills: null,
            flows: null,
            numbers: telnyx.numbers,
            assistants: telnyx.assistants,
          },
          services: {
            database: {
              status: "not_configured",
              ready: false,
              detail: "PostgreSQL is not configured",
            },
            telnyx,
            application: {
              status: "connected",
              ready: true,
              detail: "Dashboard API is responding",
            },
          },
          traffic: [],
          roleDistribution: [],
          recentActivity: [],
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const dbStartedAt = performance.now();
    let databaseStatus = {
      status: "connected",
      ready: true,
      detail: "PostgreSQL is responding",
      latencyMs: null,
    };
    try {
      await pool.query("SELECT 1 AS ok");
      databaseStatus.latencyMs = Math.max(1, Math.round(performance.now() - dbStartedAt));
    } catch (error) {
      databaseStatus = {
        status: "disconnected",
        ready: false,
        detail: "PostgreSQL health check failed",
        latencyMs: null,
      };
      adminRuntimeLogger.warn("system_dashboard_database_check_failed", {
        ...runtimePayload({ error }),
      });
    }

    const bucketSql = `
      WITH buckets AS (
        SELECT generate_series(
          date_trunc('${config.unit}', NOW()) - INTERVAL '${config.span}',
          date_trunc('${config.unit}', NOW()),
          INTERVAL '${config.step}'
        ) AS bucket
      )
      SELECT
        b.bucket,
        COUNT(DISTINCT i.id)::int AS interactions,
        COUNT(DISTINCT e.id)::int AS executions,
        COUNT(DISTINCT i.id) FILTER (WHERE i.state IN ('failed', 'abandoned'))::int AS exceptions
      FROM buckets b
      LEFT JOIN cc_interactions i
        ON i.created_at >= b.bucket AND i.created_at < b.bucket + INTERVAL '${config.step}'
      LEFT JOIN voice_flow_executions e
        ON e.started_at >= b.bucket AND e.started_at < b.bucket + INTERVAL '${config.step}'
      GROUP BY b.bucket
      ORDER BY b.bucket
    `;

    const [users, queues, skills, flows, trafficRows, roleRows, activityRows, telnyx] =
      await Promise.all([
        countTable(
          pool,
          "users",
          ", COUNT(*) FILTER (WHERE verified = true)::int AS active",
        ),
        countTable(
          pool,
          "cc_queues",
          ", COUNT(*) FILTER (WHERE active = true AND enabled = true)::int AS active",
        ),
        countTable(
          pool,
          "skills",
          ", COUNT(*) FILTER (WHERE is_active = true)::int AS active",
        ),
        countTable(pool, "voice_flows"),
        safeQuery(pool, bucketSql),
        safeQuery(
          pool,
          `SELECT role, COUNT(*)::int AS total
           FROM users
           CROSS JOIN LATERAL unnest(COALESCE(roles, ARRAY[]::text[])) AS role
           GROUP BY role
           ORDER BY total DESC, role ASC`,
        ),
        safeQuery(
          pool,
          `SELECT l.activity_type, l.activity_value, l.created_at,
                  COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.username, 'System') AS actor
           FROM cc_user_activity_log l
           LEFT JOIN users u ON u.id = l.user_id
           ORDER BY l.created_at DESC
           LIMIT 6`,
        ),
        telnyxPromise,
      ]);

    const traffic = trafficRows.map((row) => ({
      bucket: row.bucket,
      label: formatBucket(row.bucket, range),
      interactions: Number(row.interactions || 0),
      executions: Number(row.executions || 0),
      exceptions: Number(row.exceptions || 0),
    }));

    return NextResponse.json(
      {
        ok: true,
        range,
        generatedAt: new Date().toISOString(),
        inventory: {
          users: Number.isFinite(Number(users.total)) ? Number(users.total) : null,
          usersActive: Number.isFinite(Number(users.active)) ? Number(users.active) : null,
          queues: Number.isFinite(Number(queues.total)) ? Number(queues.total) : null,
          queuesActive: Number.isFinite(Number(queues.active)) ? Number(queues.active) : null,
          skills: Number.isFinite(Number(skills.total)) ? Number(skills.total) : null,
          skillsActive: Number.isFinite(Number(skills.active)) ? Number(skills.active) : null,
          flows: Number.isFinite(Number(flows.total)) ? Number(flows.total) : null,
          numbers: telnyx.numbers,
          assistants: telnyx.assistants,
        },
        services: {
          database: {
            ...databaseStatus,
            pool: {
              total: Number(pool.totalCount || 0),
              idle: Number(pool.idleCount || 0),
              waiting: Number(pool.waitingCount || 0),
            },
          },
          telnyx,
          application: {
            status: "connected",
            ready: true,
            detail: "Dashboard API is responding",
          },
        },
        traffic,
        roleDistribution: roleRows.map((row) => ({
          role: String(row.role || "unknown"),
          total: Number(row.total || 0),
        })),
        recentActivity: activityRows.map((row) => ({
          type: String(row.activity_type || "activity"),
          value: row.activity_value || null,
          actor: row.actor || "System",
          createdAt: row.created_at,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    adminRuntimeLogger.error("system_dashboard_failed", {
      ...runtimePayload({ error }),
    });
    return NextResponse.json(
      { error: error?.message || "Failed to load system dashboard" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

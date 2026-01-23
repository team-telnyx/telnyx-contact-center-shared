import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user) return null;
  if (!isAdmin(user)) return null;
  return user;
}

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ rows: [], count: 0 });

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const pageSize = Math.min(
    100,
    Math.max(1, Number(searchParams.get("pageSize") || 20))
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
      `(name ILIKE $${i} OR display_name ILIKE $${i} OR description ILIKE $${i})`
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

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json();
  const name = String(body.name || "").trim();
  if (!name)
    return NextResponse.json({ error: "name required" }, { status: 400 });

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  try {
    const id = await PgDb.insertQueue({
      name,
      displayName: body.displayName || null,
      description: body.description || null,
      routingStrategy: body.routingStrategy || "FIFO",
      maxWaitTimeSecs: body.maxWaitTimeSecs || 600,
      maxSize: body.maxSize || 100,
      timeoutSecs: body.timeoutSecs || 300,
      overflowQueueId: body.overflowQueueId || null,
      overflowAction: body.overflowAction || "transfer",
      priority: body.priority || 0,
      enabled: body.enabled !== undefined ? body.enabled : true,
      skillRequirements: body.skillRequirements || {},
      priorityRules: body.priorityRules || [],
    });

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
            ]
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
          [randomUUID(), id, wrapupCodeId]
        );
      }
    }

    // Broadcast queue created event to all agent users
    try {
      const { broadcastToAllAgents } = await import("@/lib/sse");
      const queueRes = await pool.query(
        `SELECT * FROM cc_queues WHERE id = $1`,
        [id]
      );
      const queue = queueRes.rows?.[0];
      if (queue) {
        await broadcastToAllAgents(
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
          "queue_changed"
        );
      }
    } catch (sseError) {
      console.error("[Queues] Failed to broadcast queue created:", sseError);
      // Don't fail the request if SSE fails
    }

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

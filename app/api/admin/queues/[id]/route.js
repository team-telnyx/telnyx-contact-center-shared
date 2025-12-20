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

export async function GET(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // Get queue with user assignments
  const queueRes = await pool.query(`SELECT * FROM cc_queues WHERE id=$1`, [
    id,
  ]);
  if (!queueRes.rows?.[0])
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const queue = queueRes.rows[0];

  // Get user assignments
  const assignmentsRes = await pool.query(
    `SELECT aqa.*, u.username, u.first_name, u.last_name, u.nick 
     FROM cc_queue_user_assignments aqa
     JOIN users u ON aqa.user_id = u.id
     WHERE aqa.queue_id = $1
     ORDER BY aqa.priority DESC, u.username ASC`,
    [id]
  );

  return NextResponse.json({
    ...queue,
    userAssignments: assignmentsRes.rows || [],
  });
}

export async function PUT(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const body = await request.json();

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const set = {};
  const maybeSet = (key, val) => {
    if (val !== undefined) set[key] = val;
  };

  maybeSet("name", body.name != null ? String(body.name).trim() : undefined);
  maybeSet(
    "display_name",
    body.displayName != null ? String(body.displayName) : undefined
  );
  maybeSet(
    "description",
    body.description != null ? String(body.description) : undefined
  );
  maybeSet(
    "routing_strategy",
    body.routingStrategy != null ? String(body.routingStrategy) : undefined
  );
  maybeSet(
    "max_wait_time_secs",
    body.maxWaitTimeSecs != null ? Number(body.maxWaitTimeSecs) : undefined
  );
  maybeSet("max_size", body.maxSize != null ? Number(body.maxSize) : undefined);
  maybeSet(
    "timeout_secs",
    body.timeoutSecs != null ? Number(body.timeoutSecs) : undefined
  );
  maybeSet(
    "overflow_queue_id",
    body.overflowQueueId != null ? String(body.overflowQueueId) : undefined
  );
  maybeSet(
    "overflow_action",
    body.overflowAction != null ? String(body.overflowAction) : undefined
  );
  maybeSet(
    "priority",
    body.priority != null ? Number(body.priority) : undefined
  );
  maybeSet("enabled", body.enabled != null ? Boolean(body.enabled) : undefined);
  maybeSet("active", body.active != null ? Boolean(body.active) : undefined);
  if (body.skillRequirements !== undefined) {
    set.skill_requirements = JSON.stringify(body.skillRequirements);
  }
  if (body.priorityRules !== undefined) {
    set.priority_rules = JSON.stringify(body.priorityRules);
  }

  try {
    if (Object.keys(set).length > 0) {
      const fields = [];
      const values = [];
      let i = 1;
      for (const [k, v] of Object.entries(set)) {
        fields.push(`${k}=$${i++}`);
        // Handle JSONB fields
        if (k === "skill_requirements" || k === "priority_rules") {
          values.push(v);
        } else {
          values.push(v);
        }
      }
      values.push(nowIso());
      values.push(id);
      const q = `UPDATE cc_queues SET ${fields.join(", ")}, updated_at=$${
        values.length - 1
      } WHERE id=$${values.length}`;
      await pool.query(q, values);
    }

    // Update user assignments if provided
    if (body.userAssignments && Array.isArray(body.userAssignments)) {
      // Delete existing assignments
      await pool.query(
        `DELETE FROM cc_queue_user_assignments WHERE queue_id=$1`,
        [id]
      );

      // Insert new assignments
      const { randomUUID: uuid } = await import("crypto");
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
              uuid(),
              id,
              assignment.userId,
              assignment.priority || 0,
              assignment.enabled !== undefined ? assignment.enabled : true,
            ]
          );
        }
      }

      // Broadcast queue updated event if user assignments changed
      if (body.userAssignments && Array.isArray(body.userAssignments)) {
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
                type: "queue_updated",
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
          console.error(
            "[Queues] Failed to broadcast queue updated:",
            sseError
          );
          // Don't fail the request if SSE fails
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // Check if queue is used as overflow queue
  const overflowCheck = await pool.query(
    `SELECT COUNT(*) AS c FROM cc_queues WHERE overflow_queue_id = $1`,
    [id]
  );
  if (Number(overflowCheck.rows?.[0]?.c || 0) > 0) {
    return NextResponse.json(
      { error: "Cannot delete queue that is used as overflow queue" },
      { status: 400 }
    );
  }

  await pool.query(`DELETE FROM cc_queues WHERE id=$1`, [id]);
  return NextResponse.json({ ok: true });
}

function nowIso() {
  return new Date().toISOString();
}

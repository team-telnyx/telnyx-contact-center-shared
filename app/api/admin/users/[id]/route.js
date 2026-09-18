import { publicUser } from "@/lib/users/public-user.mjs";
import { saveAdminSettings } from "@/lib/acd/utilization.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { effectiveAccess, publishAuthzChanged } from "@/lib/authz/effective.mjs";
import { validateRoleAssignment, recordRoleAssignment } from "@/lib/authz/roles-store.mjs";
import { withPermission } from "@/lib/authz/guard";
import { agentInScope, queueInScope, resolveScopeForKeys } from "@/lib/authz/scope.mjs";

const sameRoleSet = (a = [], b = []) => a.length === b.length && a.every((key) => b.includes(key));


async function GET_handler(request, { params }, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  if (!agentInScope(authz.scope, id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const r = await pool.query(`SELECT * FROM users WHERE id=$1`, [id]);
  if (!r.rows?.[0])
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get queue assignments for this user
  const queueAssignmentsRes = await pool.query(
    `SELECT * FROM cc_queue_user_assignments WHERE user_id = $1`,
    [id]
  );

  const userData = publicUser(r.rows[0]);
  userData.queue_assignments = queueAssignmentsRes.rows || [];

  return NextResponse.json(userData);
}

async function PUT_handler(request, { params }, authz) {
  const user = authz.user;
  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  if (!agentInScope(authz.scope, id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await request.json();

  const set = {};
  const maybeSet = (key, val) => {
    if (val !== undefined) set[key] = val;
  };

  maybeSet(
    "username",
    body.username != null ? String(body.username).trim() : undefined
  );
  maybeSet(
    "firstName",
    body.firstName != null ? String(body.firstName) : undefined
  );
  maybeSet(
    "lastName",
    body.lastName != null ? String(body.lastName) : undefined
  );
  maybeSet("nick", body.nick != null ? String(body.nick) : undefined);
  maybeSet(
    "language",
    body.language != null ? String(body.language) : undefined
  );
  maybeSet("status", body.status != null ? String(body.status) : undefined);
  maybeSet("theme", body.theme != null ? String(body.theme) : undefined);
  maybeSet("mobile", body.mobile != null ? String(body.mobile) : undefined);
  maybeSet(
    "smsNumber",
    body.smsNumber != null ? String(body.smsNumber) : undefined
  );
  maybeSet(
    "voiceNumber",
    body.voiceNumber != null ? String(body.voiceNumber) : undefined
  );
  // Role changes are validated against the roles table and the model's rules
  // (owner protections, delegation) and audited; see lib/authz/roles-store.mjs.
  let rolesBefore = null;
  let rolesChanged = false;
  if (body.roles !== undefined) {
    const rolePool = getPostgresPool();
    if (!rolePool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
    const currentRes = await rolePool.query(`SELECT roles FROM users WHERE id=$1`, [id]);
    if (!currentRes.rows?.[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });
    rolesBefore = Array.isArray(currentRes.rows[0].roles) && currentRes.rows[0].roles.length ? currentRes.rows[0].roles : ["agent"];
    try {
      const actorAccess = await effectiveAccess(user);
      set.roles = await validateRoleAssignment(rolePool, { actor: user, actorAccess, targetUserId: id, currentRoles: rolesBefore, nextRoles: body.roles });
    } catch (roleErr) {
      return NextResponse.json({ error: roleErr.message, details: roleErr.details }, { status: roleErr.status || 400 });
    }
    // Changing the role list is a role assignment, a separate grant from editing the profile.
    if (!sameRoleSet(rolesBefore, set.roles) && (!authz.can("users:roles.assign") || !agentInScope(await resolveScopeForKeys(rolePool, user, authz.access, ["users:roles.assign"]), id))) {
      return NextResponse.json({ error: "Forbidden", permission: "users:roles.assign" }, { status: 403 });
    }
  }
  let queueScope = null;
  if (body.queueIds !== undefined) {
    // Queue membership is routing: it needs queues:agents.assign and stays within that grant's scope.
    if (!authz.can("queues:agents.assign")) {
      return NextResponse.json({ error: "Forbidden", permission: "queues:agents.assign" }, { status: 403 });
    }
    const scopePool = getPostgresPool();
    queueScope = scopePool ? await resolveScopeForKeys(scopePool, user, authz.access, ["queues:agents.assign"]) : null;
  }
  maybeSet(
    "verified",
    body.verified != null ? Boolean(body.verified) : undefined
  );
  maybeSet("active", body.active != null ? Boolean(body.active) : undefined);
  maybeSet(
    "experimentalFeatures",
    body.experimentalFeatures != null
      ? Boolean(body.experimentalFeatures)
      : undefined,
  );
  maybeSet(
    "authStrategy",
    body.authStrategy != null ? String(body.authStrategy) : undefined
  );
  maybeSet(
    "telephonyCredentialsId",
    body.telephonyCredentialsId != null
      ? String(body.telephonyCredentialsId)
      : undefined
  );
  maybeSet(
    "telephonyUserName",
    body.telephonyUserName != null ? String(body.telephonyUserName) : undefined
  );
  maybeSet(
    "profilePictureUri",
    body.profilePictureUri != null ? String(body.profilePictureUri) : undefined
  );
  if (body.skills !== undefined) {
    // Skills is stored as JSONB object { skillId: proficiency }
    // Pass as object, PgDb will handle JSONB conversion
    set.skills = body.skills;
  }

  try {
    await saveAdminSettings(getPostgresPool(), { scope: "agent", id, utilization: body.utilization, actor: String(user.id) }, async (pool) => {
    if (set.roles && rolesBefore?.includes("owner") && !set.roles.includes("owner")) {
      // Re-checked under the transaction lock: two concurrent demotions cannot leave the system without an owner.
      const owners = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE 'owner' = ANY(roles) AND id <> $1`, [id]);
      if (Number(owners.rows?.[0]?.c || 0) === 0) throw Object.assign(new Error("The last owner cannot lose the Owner role."), { status: 409 });
    }
    const skillsChanged = body.skills !== undefined;
    const queueIdsChanged = body.queueIds !== undefined;

    await PgDb.updateUserById(id, set, pool);
    if (rolesBefore && set.roles) {
      rolesChanged = await recordRoleAssignment(pool, { actor: user, targetUserId: id, before: rolesBefore, after: set.roles });
    }

    // Handle queue assignments
    if (queueIdsChanged && Array.isArray(body.queueIds)) {
      if (pool) {
        // Get current assignments
        const currentAssignmentsRes = await pool.query(
          `SELECT queue_id FROM cc_queue_user_assignments WHERE user_id = $1 AND enabled=true AND deactivated_at IS NULL`,
          [id]
        );
        const currentQueueIds = new Set(
          currentAssignmentsRes.rows.map((row) => row.queue_id)
        );
        const newQueueIds = new Set(body.queueIds);

        // Find queues to add
        const queuesToAdd = body.queueIds.filter(
          (queueId) => !currentQueueIds.has(queueId)
        );
        // Find queues to remove
        const queuesToRemove = Array.from(currentQueueIds).filter(
          (queueId) => !newQueueIds.has(queueId)
        );
        const outsideScope = [...queuesToAdd, ...queuesToRemove].filter((queueId) => queueScope && !queueInScope(queueScope, String(queueId)));
        if (outsideScope.length) throw Object.assign(new Error("Queue outside your data scope"), { status: 403, queueIds: outsideScope });

        // Add new queue assignments
        const { randomUUID } = await import("crypto");
        for (const queueId of queuesToAdd) {
          await pool.query(
            `INSERT INTO cc_queue_user_assignments (id, queue_id, user_id, priority, enabled, activated_at, created_at, updated_at)
             VALUES ($1, $2, $3, 1, true, NOW(), NOW(), NOW())
             ON CONFLICT (queue_id, user_id) DO UPDATE SET
               enabled = true,
               activated_at = NOW(),
               deactivated_at = NULL,
               updated_at = NOW()`,
            [randomUUID(), queueId, id]
          );
        }

        // Remove/deactivate queue assignments
        if (queuesToRemove.length > 0) {
          await pool.query(
            `UPDATE cc_queue_user_assignments 
             SET enabled = false, deactivated_at = NOW(), updated_at = NOW()
             WHERE user_id = $1 AND queue_id = ANY($2::text[])`,
            [id, queuesToRemove]
          );
        }
      }
    }

    // Skills and assignments are read directly by the Core router. Wake every
    // worker after a routing-profile change so queued work is reconsidered
    // without maintaining a second interaction projection.
    if (skillsChanged || queueIdsChanged) {
      if (pool) await pool.query("SELECT pg_notify('acd_work_ready', $1)", [String(id)]);
    }

    return { id };
    });
    if (rolesChanged || body.active !== undefined) {
      // Drops role caches and pushes `authz_changed` so the user's menus and
      // API access follow within seconds (decision D-16).
      await publishAuthzChanged({ userIds: [String(id)], reason: "user.roles.update" });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ error: msg }, { status: err.status || 400 });
  }
}

async function DELETE_handler(request, { params }, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  if (!agentInScope(authz.scope, id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const targetRes = await pool.query(`SELECT roles FROM users WHERE id=$1`, [
    id,
  ]);
  const target = targetRes.rows?.[0] || null;
  if (!target)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const targetRoles = target.roles || ["agent"];
  if (targetRoles.includes("owner")) {
    return NextResponse.json(
      { error: "Owner accounts cannot be deleted" },
      { status: 400 }
    );
  }
  await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
  return NextResponse.json({ ok: true });
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("users:read", GET_handler, { route: "/api/admin/users/[id]" });
export const PUT = withPermission("users:update", PUT_handler, { route: "/api/admin/users/[id]" });
export const DELETE = withPermission("users:delete", DELETE_handler, { route: "/api/admin/users/[id]" });

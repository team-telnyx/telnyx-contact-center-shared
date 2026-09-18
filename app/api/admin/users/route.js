import { publicUser } from "@/lib/users/public-user.mjs";
import { saveAdminSettings } from "@/lib/acd/utilization.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { randomUUID, randomBytes } from "crypto";
import {
  effectiveAgentStatusSql,
  ensureAgentState,
  setManualAgentStatus,
} from "@/lib/acd/agent-state.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { effectiveAccess, publishAuthzChanged } from "@/lib/authz/effective.mjs";
import { validateRoleAssignment, recordRoleAssignment } from "@/lib/authz/roles-store.mjs";
import { withPermission } from "@/lib/authz/guard";
import { agentInScope, agentScopeSql, queueInScope, resolveScopeForKeys } from "@/lib/authz/scope.mjs";

const sameRoleSet = (a = [], b = []) => a.length === b.length && a.every((key) => b.includes(key));


async function GET_handler(request, _context, authz) {
  const user = authz.user;
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
  const username = searchParams.get("username");
  const role = searchParams.get("role");
  const verified = searchParams.get("verified");
  const status = searchParams.get("status");

  if (q) {
    where.push(
      `(u.username ILIKE $${i} OR u.first_name ILIKE $${i} OR u.last_name ILIKE $${i} OR u.nick ILIKE $${i} OR u.mobile ILIKE $${i})`
    );
    vals.push(`%${q}%`);
    i += 1;
  }
  if (username) {
    where.push(`u.username ILIKE $${i}`);
    vals.push(`%${username}%`);
    i += 1;
  }
  if (role && role !== "all") {
    // Check roles array only
    where.push(`$${i} = ANY(u.roles)`);
    vals.push(role);
    i += 1;
  }
  const effectiveStatusSql = effectiveAgentStatusSql("s");
  if (status) {
    where.push(`${effectiveStatusSql}=$${i}`);
    vals.push(status);
    i += 1;
  }
  if (verified === "true" || verified === "false") {
    where.push(`u.verified=$${i}`);
    vals.push(verified === "true");
    i += 1;
  }
  // Team/queue scope of the granting roles (Phase 3a).
  where.push(...agentScopeSql(authz.scope, "u.id", vals));
  i = vals.length + 1;

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const fromSql = `FROM users u LEFT JOIN acd_agent_state s ON s.agent_id = u.id`;
  const rowsSql = `SELECT u.id, u.username, u.first_name, u.last_name, u.nick, u.mobile, u.roles, u.verified, u.experimental_features, ${effectiveStatusSql} AS status, u.skills, u.created_at, u.updated_at ${fromSql} ${whereSql} ORDER BY u.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
  const [rowsRes, countRes] = await Promise.all([
    pool.query(rowsSql, vals),
    pool.query(`SELECT COUNT(*) AS c ${fromSql} ${whereSql}`, vals),
  ]);
  return NextResponse.json({
    rows: rowsRes.rows || [],
    count: Number(countRes.rows?.[0]?.c || 0),
  });
}

async function POST_handler(request, _context, authz) {
  const adminUser = authz.user;
  const body = await request.json();

  // If creating a new user (has firstName/lastName) vs legacy upsert
  const isCreateUser = body.firstName !== undefined || body.lastName !== undefined;

  if (isCreateUser) {
    // New user creation flow
    const username = String(body.username || "").trim();
    const firstName = String(body.firstName || "").trim();
    const lastName = String(body.lastName || "").trim();
    const role = body.role || "agent";
    let roles = body.roles || [role];
    const nick = body.nick || null;
    const mobile = body.mobile || null;
    const sendInvite = Boolean(body.sendInvite !== false); // default true
    const experimentalFeatures = body.experimentalFeatures === true;

    if (!username) {
      return NextResponse.json({ error: "Email (username) is required" }, { status: 400 });
    }
    if (!firstName) {
      return NextResponse.json({ error: "First name is required" }, { status: 400 });
    }
    if (!lastName) {
      return NextResponse.json({ error: "Last name is required" }, { status: 400 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json({ error: "Server not ready" }, { status: 500 });
    }

    // Role keys must exist, only an owner grants owner, and the creator must
    // hold everything the roles grant (delegation rule).
    try {
      const actorAccess = await effectiveAccess(adminUser);
      roles = await validateRoleAssignment(pool, { actor: adminUser, actorAccess, targetUserId: null, currentRoles: [], nextRoles: roles });
    } catch (roleErr) {
      return NextResponse.json({ error: roleErr.message, details: roleErr.details }, { status: roleErr.status || 400 });
    }
    // Anything beyond the base role is a role assignment (users:roles.assign);
    // queue membership is routing (queues:agents.assign) and stays within that grant's scope.
    if (roles.some((key) => key !== "agent") && !authz.can("users:roles.assign")) {
      return NextResponse.json({ error: "Forbidden", permission: "users:roles.assign" }, { status: 403 });
    }
    const requestedQueueIds = [...new Set(Array.isArray(body.queueIds) ? body.queueIds.map(String) : [])];
    if (requestedQueueIds.length) {
      if (!authz.can("queues:agents.assign")) {
        return NextResponse.json({ error: "Forbidden", permission: "queues:agents.assign" }, { status: 403 });
      }
      const queueScope = await resolveScopeForKeys(pool, adminUser, authz.access, ["queues:agents.assign"]);
      const outside = requestedQueueIds.filter((queueId) => !queueInScope(queueScope, queueId));
      if (outside.length) return NextResponse.json({ error: "Queue outside your data scope", queueIds: outside }, { status: 403 });
    }

    // Validate email domain against allowed domains
    const emailDomain = username.split("@")[1]?.toLowerCase();
    if (!emailDomain) {
      return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
    }
    const allowedDomains = await pool.query(
      "SELECT domain FROM domains WHERE active=true ORDER BY domain"
    );
    if (allowedDomains.rows.length > 0) {
      const domainList = allowedDomains.rows.map((r) => r.domain.toLowerCase());
      if (!domainList.includes(emailDomain)) {
        return NextResponse.json(
          { error: `Email domain "@${emailDomain}" is not allowed. Allowed domains: ${domainList.map((d) => "@" + d).join(", ")}` },
          { status: 422 }
        );
      }
    }

    // Check if username already exists
    const existing = await pool.query(
      "SELECT id FROM users WHERE username=$1 LIMIT 1",
      [username]
    );
    if (existing.rows?.length > 0) {
      return NextResponse.json(
        { error: "A user with this email already exists" },
        { status: 409 }
      );
    }

    const id = randomUUID();
    let inviteToken = null;
    let inviteExpires = null;
    let inviteSentAt = null;
    let inviteStatus = "none";

    if (sendInvite) {
      inviteToken = randomBytes(32).toString("hex");
      inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      inviteSentAt = new Date();
      inviteStatus = "pending";
    }

    try {
      await saveAdminSettings(pool, { scope: "agent", id, create: true, utilization: body.utilization, actor: String(adminUser.id) }, async (pool) => {
    // Insert new user (no password)
    await pool.query(
      `INSERT INTO users (
        id, username, first_name, last_name, nick, mobile, roles,
        active, verified, auth_strategy, language, theme,
        invite_token, invite_token_expires, invite_sent_at, invite_status,
        skills, agent_groups, preferred_languages, experimental_features,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        false, false, 'local', 'en-US', 'system',
        $8, $9, $10, $11,
        '{}', '{}', ARRAY['en-US']::TEXT[], $12,
        NOW(), NOW()
      )`,
      [
        id, username, firstName, lastName, nick, mobile,
        Array.isArray(roles) ? roles : [roles],
        inviteToken, inviteExpires, inviteSentAt, inviteStatus,
        experimentalFeatures,
      ]
    );

    await ensureAgentState(pool, id);
    await recordRoleAssignment(pool, { actor: adminUser, targetUserId: id, before: [], after: roles });

      await PgDb.updateUserById(id, {
        skills: body.skills || {}, voiceNumber: body.voiceNumber || null,
        smsNumber: body.smsNumber || "Telnyx",
        active: Boolean(body.active), verified: Boolean(body.verified),
      }, pool);
      for (const queueId of [...new Set(Array.isArray(body.queueIds) ? body.queueIds : [])]) {
        await pool.query(`INSERT INTO cc_queue_user_assignments
          (id,queue_id,user_id,priority,enabled,activated_at,created_at,updated_at)
          VALUES($1,$2,$3,1,true,now(),now(),now())`, [randomUUID(),queueId,id]);
      }
      return { id };
      });
    } catch (error) {
      return NextResponse.json({ error: error.message }, { status: error.status || 400 });
    }

    // Send invite email if requested
    if (sendInvite && inviteToken) {
      const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
      const inviteUrl = `${baseUrl}/set-password/${inviteToken}`;
      try {
        const { sendUserInviteEmail } = await import("@/lib/email-notifications.js");
        await sendUserInviteEmail(
          { first_name: firstName, last_name: lastName, username },
          inviteUrl
        );
      } catch (emailError) {
        adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
        // Don't fail - user was created
      }
    }

    const newUser = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
    return NextResponse.json({ ok: true, user: publicUser(newUser.rows?.[0]) }, { status: 201 });
  }

  // Legacy upsert flow (backwards compatible)
  const username = String(body.username || "").trim();
  if (!username)
    return NextResponse.json({ error: "username required" }, { status: 400 });

  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  // The upsert may rewrite an existing account: that needs users:update, and the
  // roles follow the same assignment rules, audit and push as the user sheet.
  const existingRes = await pool.query(`SELECT id, roles FROM users WHERE LOWER(username) = LOWER($1)`, [username]);
  const existing = existingRes.rows?.[0] || null;
  if (existing && (!authz.can("users:update") || !agentInScope(await resolveScopeForKeys(pool, adminUser, authz.access, ["users:update"]), existing.id))) {
    return NextResponse.json({ error: "Forbidden", permission: "users:update" }, { status: 403 });
  }
  const currentRoles = existing ? (Array.isArray(existing.roles) && existing.roles.length ? existing.roles : ["agent"]) : [];
  let roles = Array.isArray(body.roles) && body.roles.length ? body.roles : (existing ? currentRoles : ["agent"]);
  try {
    const actorAccess = await effectiveAccess(adminUser);
    roles = await validateRoleAssignment(pool, { actor: adminUser, actorAccess, targetUserId: existing ? String(existing.id) : null, currentRoles, nextRoles: roles });
  } catch (roleErr) {
    return NextResponse.json({ error: roleErr.message, details: roleErr.details }, { status: roleErr.status || 400 });
  }
  const rolesChange = existing ? !sameRoleSet(currentRoles, roles) : roles.some((key) => key !== "agent");
  if (rolesChange && (!authz.can("users:roles.assign") || (existing && !agentInScope(await resolveScopeForKeys(pool, adminUser, authz.access, ["users:roles.assign"]), existing.id)))) {
    return NextResponse.json({ error: "Forbidden", permission: "users:roles.assign" }, { status: 403 });
  }

  const fields = {
    firstName: body.firstName || null,
    lastName: body.lastName || null,
    nick: body.nick || null,
    language: body.language || "en-US",
    status: body.status || "Available",
    theme: body.theme || "system",
    mobile: body.mobile || null,
    smsNumber: body.smsNumber || "Telnyx",
    voiceNumber: body.voiceNumber || null,
    roles, // validated above
    verified: Boolean(body.verified),
    authStrategy: body.authStrategy || "local",
    telephonyCredentialsId: body.telephonyCredentialsId || null,
    telephonyUserName: body.telephonyUserName || null,
    profilePictureUri: body.profilePictureUri || null,
  };

  try {
    const id = await PgDb.upsertUserByUsername(username, fields);
    if (existing && rolesChange) {
      await recordRoleAssignment(pool, { actor: adminUser, targetUserId: String(id), before: currentRoles, after: roles });
      await publishAuthzChanged({ userIds: [String(id)], reason: "user.roles.update" });
    }
    if (body.status && body.status !== "Available") {
      await setManualAgentStatus(pool, {
        agentId: String(id),
        status: String(body.status),
        actor: `admin:${adminUser.id}`,
      });
    }
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("users:read", GET_handler, { route: "/api/admin/users" });
export const POST = withPermission("users:create", POST_handler, { route: "/api/admin/users" });

import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { requireAiApiKey, jsonOk, jsonError } from "@/app/api/_utils/ai-auth";
import { normalizeCustomDataValue } from "@/lib/custom-data-utils";
import { withPermission } from "@/lib/authz/guard";

// Support both admin session and API key authentication
// Machine access (telnyx-ai-api-key) or an administrator session; the guard decides.
function requireAuth(authz) {
  return authz.apiKey ? { type: "api_key", user: null } : { type: "session", user: authz.user };
}

async function GET_handler(request, { params }, authz) {
  const auth = requireAuth(authz);
  if (!auth) {
    if (auth === null) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return jsonError("Unauthorized", 401);
  }

  const pool = getPostgresPool();
  if (!pool) {
    if (auth.type === "api_key") {
      return jsonError("Database not configured", 500);
    }
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  }

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) {
    if (auth.type === "api_key") {
      return jsonError("Missing id", 400);
    }
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const r = await pool.query(
    `SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL`,
    [id],
  );
  if (!r.rows?.[0]) {
    if (auth.type === "api_key") {
      return jsonError("Not found", 404);
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (auth.type === "api_key") {
    return jsonOk(r.rows[0]);
  }
  return NextResponse.json(r.rows[0]);
}

async function PATCH_handler(request, { params }, authz) {
  const auth = requireAuth(authz);
  if (!auth) {
    if (auth === null) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return jsonError("Unauthorized", 401);
  }

  const pool = getPostgresPool();
  if (!pool) {
    if (auth.type === "api_key") {
      return jsonError("Database not configured", 500);
    }
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  }

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) {
    if (auth.type === "api_key") {
      return jsonError("Missing id", 400);
    }
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const body = await request.json();
  let customData;
  try {
    customData = normalizeCustomDataValue(body.custom_data, { allowUndefined: true });
  } catch (err) {
    const error = err?.message || "Custom data must be a valid JSON object";
    if (auth.type === "api_key") {
      return jsonError(error, 400);
    }
    return NextResponse.json({ error }, { status: 400 });
  }
  const updates = [];
  const vals = [];
  let i = 1;

  // Helper to add field updates
  const maybeSet = (key, val, json = false) => {
    if (val !== undefined) {
      updates.push(`${key}=$${i}`);
      vals.push(json ? JSON.stringify(val) : val);
      i += 1;
    }
  };

  maybeSet("title", body.title?.trim());
  maybeSet("description", body.description?.trim());
  maybeSet("task_type", body.task_type?.trim());
  maybeSet("status", body.status);
  maybeSet("priority", body.priority);
  maybeSet("caller_name", body.caller_name?.trim());
  maybeSet("caller_phone", body.caller_phone?.trim());
  maybeSet("caller_email", body.caller_email?.trim());
  maybeSet("contact_id", body.contact_id);
  maybeSet("assigned_to", body.assigned_to);
  maybeSet("call_control_id", body.call_control_id);
  maybeSet("interaction_id", body.interaction_id);
  maybeSet("flow_id", body.flow_id);
  maybeSet("due_date", body.due_date);
  maybeSet("metadata", body.metadata, true);
  if (customData !== undefined) {
    maybeSet("custom_data", customData, true);
  }
  if (body.tags !== undefined) {
    maybeSet(
      "tags",
      Array.isArray(body.tags) ? body.tags : body.tags ? [body.tags] : [],
    );
  }

  // Handle status changes - update resolved_at/closed_at timestamps
  if (body.status === "resolved" || body.status === "closed") {
    const existingRes = await pool.query(
      `SELECT status FROM tasks WHERE id=$1 AND deleted_at IS NULL`,
      [id],
    );
    if (existingRes.rows?.[0]) {
      const existingStatus = existingRes.rows[0].status;
      if (existingStatus !== "resolved" && existingStatus !== "closed") {
        if (body.status === "resolved") {
          updates.push(`resolved_at=NOW()`);
          // Set resolved_by if user is authenticated
          if (auth.type === "session" && auth.user) {
            updates.push(`resolved_by=$${i}`);
            vals.push(auth.user.id);
            i += 1;
          }
        }
        if (body.status === "closed") {
          updates.push(`closed_at=NOW()`);
        }
      }
    }
  }

  if (updates.length === 0) {
    if (auth.type === "api_key") {
      return jsonError("No fields to update", 400);
    }
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  // Validate status if provided
  if (
    body.status &&
    !["open", "in_progress", "resolved", "closed", "cancelled"].includes(
      body.status,
    )
  ) {
    const error =
      "Status must be one of: open, in_progress, resolved, closed, cancelled";
    if (auth.type === "api_key") {
      return jsonError(error, 400);
    }
    return NextResponse.json({ error }, { status: 400 });
  }

  // Validate priority if provided
  if (
    body.priority &&
    !["low", "medium", "high", "urgent"].includes(body.priority)
  ) {
    const error = "Priority must be one of: low, medium, high, urgent";
    if (auth.type === "api_key") {
      return jsonError(error, 400);
    }
    return NextResponse.json({ error }, { status: 400 });
  }

  updates.push(`updated_at=NOW()`);
  vals.push(id);

  try {
    const result = await pool.query(
      `UPDATE tasks SET ${updates.join(", ")} WHERE id=$${i} AND deleted_at IS NULL RETURNING *`,
      vals,
    );

    if (result.rows.length === 0) {
      if (auth.type === "api_key") {
        return jsonError("Not found", 404);
      }
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (auth.type === "api_key") {
      return jsonOk(result.rows[0]);
    }
    return NextResponse.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    const msg = err?.message || String(err);
    if (auth.type === "api_key") {
      return jsonError(msg, 400);
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

async function DELETE_handler(request, { params }, authz) {
  const auth = requireAuth(authz);
  if (!auth) {
    if (auth === null) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return jsonError("Unauthorized", 401);
  }

  const pool = getPostgresPool();
  if (!pool) {
    if (auth.type === "api_key") {
      return jsonError("Database not configured", 500);
    }
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  }

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) {
    if (auth.type === "api_key") {
      return jsonError("Missing id", 400);
    }
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  // Soft delete by setting deleted_at
  try {
    const result = await pool.query(
      `UPDATE tasks SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
      [id],
    );

    if (result.rows.length === 0) {
      if (auth.type === "api_key") {
        return jsonError("Not found", 404);
      }
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (auth.type === "api_key") {
      return jsonOk({ deleted: true });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    if (auth.type === "api_key") {
      return jsonError(msg, 400);
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

// Phase 2 migration: every export goes through the permission guard; API-key callers keep their access.
export const GET = withPermission("tasks:read", GET_handler, { apiKey: requireAiApiKey, route: "/api/tasks/[id]" });
export const PATCH = withPermission("tasks:update", PATCH_handler, { apiKey: requireAiApiKey, route: "/api/tasks/[id]" });
export const DELETE = withPermission("tasks:delete", DELETE_handler, { apiKey: requireAiApiKey, route: "/api/tasks/[id]" });

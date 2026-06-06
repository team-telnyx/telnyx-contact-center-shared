export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { requireAiApiKey, jsonOk, jsonError } from "@/app/api/_utils/ai-auth";
import { randomUUID } from "crypto";
import { normalizeCustomDataValue } from "@/lib/custom-data-utils";

// Support both admin session and API key authentication
async function requireAuth(request) {
  // Try API key authentication first
  const apiAuth = requireAiApiKey(request);
  if (apiAuth.ok) return { type: "api_key", user: null };

  // Fall back to admin session authentication
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user) return null;
  if (!isAdmin(user)) return null;
  return { type: "session", user };
}

export async function GET(request) {
  const auth = await requireAuth(request);
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
    return NextResponse.json({ rows: [], count: 0 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const pageSize = Math.min(
    100,
    Math.max(1, Number(searchParams.get("pageSize") || 20)),
  );
  const offset = (page - 1) * pageSize;

  const where = ["deleted_at IS NULL"];
  const vals = [];
  let i = 1;

  const q = searchParams.get("q");
  const status = searchParams.get("status");
  const taskType = searchParams.get("task_type");
  const priority = searchParams.get("priority");
  const assignedTo = searchParams.get("assigned_to");
  const createdBy = searchParams.get("created_by");
  const contactId = searchParams.get("contact_id");

  if (q) {
    where.push(
      `(title ILIKE $${i} OR description ILIKE $${i} OR caller_name ILIKE $${i})`,
    );
    vals.push(`%${q}%`);
    i += 1;
  }
  if (status) {
    where.push(`status = $${i}`);
    vals.push(status);
    i += 1;
  }
  if (taskType) {
    where.push(`task_type = $${i}`);
    vals.push(taskType);
    i += 1;
  }
  if (priority) {
    where.push(`priority = $${i}`);
    vals.push(priority);
    i += 1;
  }
  if (assignedTo) {
    where.push(`assigned_to = $${i}`);
    vals.push(assignedTo);
    i += 1;
  }
  if (createdBy) {
    where.push(`created_by = $${i}`);
    vals.push(createdBy);
    i += 1;
  }
  if (contactId) {
    where.push(`contact_id = $${i}`);
    vals.push(contactId);
    i += 1;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rowsSql = `SELECT * FROM tasks ${whereSql} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
  const [rowsRes, countRes] = await Promise.all([
    pool.query(rowsSql, vals),
    pool.query(`SELECT COUNT(*) AS c FROM tasks ${whereSql}`, vals),
  ]);

  const result = {
    rows: rowsRes.rows || [],
    count: Number(countRes.rows?.[0]?.c || 0),
  };

  if (auth.type === "api_key") {
    return jsonOk(result);
  }
  return NextResponse.json(result);
}

export async function POST(request) {
  const auth = await requireAuth(request);
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
    return NextResponse.json(
      { error: "Database not configured" },
      { status: 500 },
    );
  }

  const body = await request.json();
  const id = body.id || randomUUID();
  const now = new Date().toISOString();
  let customData;
  try {
    customData = normalizeCustomDataValue(body.custom_data);
  } catch (err) {
    const error = err?.message || "Custom data must be a valid JSON object";
    if (auth.type === "api_key") {
      return jsonError(error, 400);
    }
    return NextResponse.json({ error }, { status: 400 });
  }

  // Validate required fields
  if (!body.title || !body.task_type) {
    const error = "Title and task_type are required";
    if (auth.type === "api_key") {
      return jsonError(error, 400);
    }
    return NextResponse.json({ error }, { status: 400 });
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

  // Get user ID for created_by
  const createdById =
    auth.type === "session" && auth.user
      ? auth.user.id
      : body.created_by || null;

  // Prepare data
  const taskData = {
    id,
    title: body.title.trim(),
    description: body.description?.trim() || null,
    task_type: body.task_type.trim(),
    status: body.status || "open",
    priority: body.priority || "medium",
    caller_name: body.caller_name?.trim() || null,
    caller_phone: body.caller_phone?.trim() || null,
    caller_email: body.caller_email?.trim() || null,
    contact_id: body.contact_id || null,
    created_by: createdById,
    assigned_to: body.assigned_to || null,
    call_control_id: body.call_control_id || null,
    interaction_id: body.interaction_id || null,
    flow_id: body.flow_id || null,
    due_date: body.due_date || null,
    metadata: body.metadata || {},
    custom_data: customData,
    tags: Array.isArray(body.tags) ? body.tags : body.tags ? [body.tags] : [],
    created_at: now,
    updated_at: now,
  };

  try {
    const query = `
      INSERT INTO tasks (
        id, title, description, task_type, status, priority,
        caller_name, caller_phone, caller_email, contact_id,
        created_by, assigned_to, call_control_id, interaction_id, flow_id,
        due_date, metadata, custom_data, tags, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
      ) RETURNING *
    `;
    const result = await pool.query(query, [
      taskData.id,
      taskData.title,
      taskData.description,
      taskData.task_type,
      taskData.status,
      taskData.priority,
      taskData.caller_name,
      taskData.caller_phone,
      taskData.caller_email,
      taskData.contact_id,
      taskData.created_by,
      taskData.assigned_to,
      taskData.call_control_id,
      taskData.interaction_id,
      taskData.flow_id,
      taskData.due_date,
      JSON.stringify(taskData.metadata),
      JSON.stringify(taskData.custom_data),
      taskData.tags,
      taskData.created_at,
      taskData.updated_at,
    ]);

    const response = { ok: true, id: result.rows[0].id, data: result.rows[0] };
    if (auth.type === "api_key") {
      return jsonOk(response.data, 201);
    }
    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    const msg = err?.message || String(err);
    if (auth.type === "api_key") {
      return jsonError(msg, 400);
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

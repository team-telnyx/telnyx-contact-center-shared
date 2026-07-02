import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { requireAiApiKey, jsonOk, jsonError } from "@/app/api/_utils/ai-auth";
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

export async function GET(request, { params }) {
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
    `SELECT * FROM contacts WHERE id=$1 AND deleted_at IS NULL`,
    [id]
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

export async function PATCH(request, { params }) {
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
  const set = {};
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

  maybeSet("first_name", body.first_name);
  maybeSet("last_name", body.last_name);
  maybeSet("display_name", body.display_name);
  maybeSet("company_name", body.company_name);
  maybeSet("job_title", body.job_title);
  maybeSet("department", body.department);
  maybeSet("phone", body.phone);
  maybeSet("mobile", body.mobile);
  maybeSet("business_phone_1", body.business_phone_1);
  maybeSet("business_phone_2", body.business_phone_2);
  maybeSet("home_phone_1", body.home_phone_1);
  maybeSet("home_phone_2", body.home_phone_2);
  maybeSet("email_address_1", body.email_address_1);
  maybeSet("email_address_2", body.email_address_2);
  maybeSet("address_street", body.address_street);
  maybeSet("address_city", body.address_city);
  maybeSet("address_state", body.address_state);
  maybeSet("address_zip", body.address_zip);
  maybeSet("address_country", body.address_country);
  maybeSet("notes", body.notes);
  if (customData !== undefined) {
    maybeSet("custom_data", customData, true);
  }

  if (updates.length === 0) {
    if (auth.type === "api_key") {
      return jsonError("Nothing to update", 400);
    }
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // Add updated_at and updated_by
  updates.push(`updated_at=$${i}`);
  vals.push(new Date().toISOString());
  i += 1;

  if (auth.type === "session") {
    updates.push(`updated_by=$${i}`);
    vals.push(auth.user.id);
    i += 1;
  }

  // Add id for WHERE clause
  vals.push(id);

  try {
    const query = `UPDATE contacts SET ${updates.join(
      ", "
    )} WHERE id=$${i} AND deleted_at IS NULL RETURNING *`;
    const result = await pool.query(query, vals);

    if (result.rows.length === 0) {
      if (auth.type === "api_key") {
        return jsonError("Not found", 404);
      }
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (auth.type === "api_key") {
      return jsonOk({ updated: true, data: result.rows[0] });
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

export async function DELETE(request, { params }) {
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
      `UPDATE contacts SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
      [id]
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

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { requireAiApiKey, jsonOk, jsonError } from "@/app/api/_utils/ai-auth";
import { randomUUID } from "crypto";

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
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
    Math.max(1, Number(searchParams.get("pageSize") || 20))
  );
  const offset = (page - 1) * pageSize;

  const where = ["deleted_at IS NULL"];
  const vals = [];
  let i = 1;

  const q = searchParams.get("q");
  const phone = searchParams.get("phone");
  const email = searchParams.get("email");
  const company = searchParams.get("company");
  const tag = searchParams.get("tag");
  const category = searchParams.get("category");

  if (q) {
    where.push(
      `(first_name ILIKE $${i} OR last_name ILIKE $${i} OR display_name ILIKE $${i} OR company_name ILIKE $${i} OR notes ILIKE $${i})`
    );
    vals.push(`%${q}%`);
    i += 1;
  }
  if (phone) {
    where.push(
      `(phone ILIKE $${i} OR mobile ILIKE $${i} OR business_phone_1 ILIKE $${i} OR business_phone_2 ILIKE $${i} OR home_phone_1 ILIKE $${i} OR home_phone_2 ILIKE $${i})`
    );
    vals.push(`%${phone}%`);
    i += 1;
  }
  if (email) {
    where.push(`(email_address_1 ILIKE $${i} OR email_address_2 ILIKE $${i})`);
    vals.push(`%${email}%`);
    i += 1;
  }
  if (company) {
    where.push(`company_name ILIKE $${i}`);
    vals.push(`%${company}%`);
    i += 1;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rowsSql = `SELECT * FROM contacts ${whereSql} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
  const [rowsRes, countRes] = await Promise.all([
    pool.query(rowsSql, vals),
    pool.query(`SELECT COUNT(*) AS c FROM contacts ${whereSql}`, vals),
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
      { status: 500 }
    );
  }

  const body = await request.json();
  const id = body.id || randomUUID();
  const now = new Date().toISOString();

  // Validate required fields
  if (
    !body.first_name &&
    !body.last_name &&
    !body.display_name &&
    !body.company_name
  ) {
    const error =
      "At least one of first_name, last_name, display_name, or company_name is required";
    if (auth.type === "api_key") {
      return jsonError(error, 400);
    }
    return NextResponse.json({ error }, { status: 400 });
  }

  // Prepare data
  const contactData = {
    id,
    first_name: body.first_name || null,
    last_name: body.last_name || null,
    display_name: body.display_name || null,
    company_name: body.company_name || null,
    job_title: body.job_title || null,
    department: body.department || null,
    phone: body.phone || null,
    mobile: body.mobile || null,
    business_phone_1: body.business_phone_1 || null,
    business_phone_2: body.business_phone_2 || null,
    home_phone_1: body.home_phone_1 || null,
    home_phone_2: body.home_phone_2 || null,
    email_address_1: body.email_address_1 || null,
    email_address_2: body.email_address_2 || null,
    address_street: body.address_street || null,
    address_city: body.address_city || null,
    address_state: body.address_state || null,
    address_zip: body.address_zip || null,
    address_country: body.address_country || null,
    notes: body.notes || null,
    created_by: auth.type === "session" ? auth.user.id : null,
    created_at: now,
    updated_at: now,
  };

  try {
    const query = `
      INSERT INTO contacts (
        id, first_name, last_name, display_name, company_name, job_title, department,
        phone, mobile, business_phone_1, business_phone_2, home_phone_1, home_phone_2,
        email_address_1, email_address_2,
        address_street, address_city, address_state, address_zip, address_country,
        notes, created_by, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
      ) RETURNING *
    `;
    const result = await pool.query(query, [
      contactData.id,
      contactData.first_name,
      contactData.last_name,
      contactData.display_name,
      contactData.company_name,
      contactData.job_title,
      contactData.department,
      contactData.phone,
      contactData.mobile,
      contactData.business_phone_1,
      contactData.business_phone_2,
      contactData.home_phone_1,
      contactData.home_phone_2,
      contactData.email_address_1,
      contactData.email_address_2,
      contactData.address_street,
      contactData.address_city,
      contactData.address_state,
      contactData.address_zip,
      contactData.address_country,
      contactData.notes,
      contactData.created_by,
      contactData.created_at,
      contactData.updated_at,
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

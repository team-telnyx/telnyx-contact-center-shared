import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


async function GET_handler(request, { params }, authz) {
  const user = authz.user;

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const res = await pool.query(`SELECT * FROM domains WHERE id = $1`, [id]);

    if (!res.rows?.[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(res.rows[0]);
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to load domain" },
      { status: 500 }
    );
  }
}

async function PUT_handler(request, { params }, authz) {
  const user = authz.user;

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const body = await request.json();
    const { domain, active } = body;

    if (!domain || !domain.trim()) {
      return NextResponse.json(
        { error: "Domain is required" },
        { status: 400 }
      );
    }

    // Basic domain validation
    const domainRegex = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/i;
    if (!domainRegex.test(domain.trim())) {
      return NextResponse.json(
        { error: "Invalid domain format. Example: example.com" },
        { status: 400 }
      );
    }

    await pool.query(
      `UPDATE domains
       SET domain = $1, active = $2, updated_at = NOW()
       WHERE id = $3`,
      [
        domain.trim().toLowerCase(),
        active !== undefined ? Boolean(active) : true,
        id,
      ]
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    if (err.code === "23505") {
      return NextResponse.json(
        { error: "A domain with this name already exists" },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to update domain" },
      { status: 500 }
    );
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

  try {
    // Get domain name first
    const domainRes = await pool.query(
      `SELECT domain FROM domains WHERE id = $1`,
      [id]
    );

    if (!domainRes.rows?.[0]) {
      return NextResponse.json({ error: "Domain not found" }, { status: 404 });
    }

    const domainName = domainRes.rows[0].domain;

    // Check if domain is being used by any users
    const userUsageRes = await pool.query(
      `SELECT COUNT(*) as count FROM users WHERE email LIKE '%@' || $1`,
      [domainName]
    );
    const userUsageCount = parseInt(userUsageRes.rows[0]?.count || "0", 10);

    if (userUsageCount > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete domain: it is used by ${userUsageCount} user(s)`,
        },
        { status: 400 }
      );
    }

    await pool.query(`DELETE FROM domains WHERE id = $1`, [id]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to delete domain" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("domains:read", GET_handler, { route: "/api/admin/domains/[id]" });
export const PUT = withPermission("domains:update", PUT_handler, { route: "/api/admin/domains/[id]" });
export const DELETE = withPermission("domains:delete", DELETE_handler, { route: "/api/admin/domains/[id]" });

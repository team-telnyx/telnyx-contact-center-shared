import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { randomUUID } from "crypto";
import { resolveSimpleSecretReferences } from "@/lib/secrets";

/**
 * GET /api/admin/web-pages
 * List all web pages
 */
export async function GET(request) {
  try {
    const user = await getAuthenticatedUser(request.url);
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Database not configured" },
        { status: 500 },
      );
    }

    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get("activeOnly") === "true";

    let query = `
      SELECT id, name, description, url, icon, order_index, is_active, created_by, created_at, updated_at
      FROM web_pages
    `;
    const params = [];

    if (activeOnly) {
      query += ` WHERE is_active = $1`;
      params.push(true);
    }

    query += ` ORDER BY order_index ASC, created_at ASC`;

    const result = await pool.query(query, params);
    const pages = result.rows || [];

    // Resolve secret references in URLs for agent desktop (when activeOnly=true)
    if (activeOnly) {
      const resolvedPages = await Promise.all(
        pages.map(async (page) => {
          if (page.url && page.url.includes("{{")) {
            try {
              const resolvedUrl = await resolveSimpleSecretReferences(page.url);
              return { ...page, url: resolvedUrl };
            } catch (err) {
              console.error(`[WebPages] Error resolving secrets in URL for page ${page.id}:`, err);
              return page; // Return original URL if resolution fails
            }
          }
          return page;
        })
      );
      return NextResponse.json({ ok: true, pages: resolvedPages });
    }

    return NextResponse.json({ ok: true, pages });
  } catch (err) {
    console.error("[WebPages] GET error:", err);
    return NextResponse.json(
      { ok: false, error: String(err.message || err) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/admin/web-pages
 * Create a new web page
 */
export async function POST(request) {
  try {
    const user = await getAuthenticatedUser(request.url);
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const body = await request.json();
    const { name, description, url, icon, order_index, is_active } = body;

    if (!name || !url) {
      return NextResponse.json(
        { ok: false, error: "Name and URL are required" },
        { status: 400 },
      );
    }

    // Validate URL
    try {
      new URL(url);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid URL format" },
        { status: 400 },
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Database not configured" },
        { status: 500 },
      );
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    const result = await pool.query(
      `
      INSERT INTO web_pages (id, name, description, url, icon, order_index, is_active, created_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `,
      [
        id,
        name,
        description || null,
        url,
        icon || null,
        order_index || 0,
        is_active !== undefined ? is_active : true,
        user.id || null,
        now,
        now,
      ],
    );

    return NextResponse.json({ ok: true, page: result.rows[0] });
  } catch (err) {
    console.error("[WebPages] POST error:", err);
    return NextResponse.json(
      { ok: false, error: String(err.message || err) },
      { status: 500 },
    );
  }
}

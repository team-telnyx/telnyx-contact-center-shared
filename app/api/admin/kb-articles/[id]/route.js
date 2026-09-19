import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { requireAiApiKey } from "@/app/api/_utils/ai-auth";
import { normalizeCustomDataValue } from "@/lib/custom-data-utils";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

// Machine access (telnyx-ai-api-key) or an administrator session; the guard decides.
function requireAuth(authz) {
  return authz.apiKey ? { type: "api_key", user: null } : { type: "session", user: authz.user };
}

async function GET_handler(request, { params }, authz) {
  const auth = requireAuth(authz);
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const res = await pool.query(
      `SELECT * FROM kb_articles WHERE id = $1`,
      [id]
    );

    if (!res.rows?.[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(res.rows[0]);
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to load article" },
      { status: 500 }
    );
  }
}

async function PUT_handler(request, { params }, authz) {
  const auth = requireAuth(authz);
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const body = await request.json();
    const {
      title,
      slug,
      summary,
      content,
      category,
      subcategory,
      tags,
      keywords,
      authorName,
      status,
      language,
    } = body;

    let customData;
    try {
      customData = normalizeCustomDataValue(body.custom_data);
    } catch (err) {
      return NextResponse.json(
        { error: err?.message || "Custom data must be a valid JSON object" },
        { status: 400 }
      );
    }

    if (!title || !slug || !content || !category) {
      return NextResponse.json(
        { error: "Title, slug, content, and category are required" },
        { status: 400 }
      );
    }

    if (!["Draft", "Published", "Archived"].includes(status)) {
      return NextResponse.json(
        { error: "Status must be 'Draft', 'Published', or 'Archived'" },
        { status: 400 }
      );
    }

    // Check if article exists
    const existingRes = await pool.query(
      `SELECT id, status, published_at FROM kb_articles WHERE id = $1`,
      [id]
    );

    if (!existingRes.rows?.[0]) {
      return NextResponse.json({ error: "Article not found" }, { status: 404 });
    }

    const existing = existingRes.rows[0];
    let publishedAt = existing.published_at;

    // Set published_at if status is changing to Published and it wasn't published before
    if (status === "Published" && existing.status !== "Published") {
      publishedAt = new Date().toISOString();
    }

    await pool.query(
      `UPDATE kb_articles
       SET title = $1, slug = $2, summary = $3, content = $4, category = $5, subcategory = $6, tags = $7, keywords = $8, author_name = $9, status = $10, language = $11, custom_data = $12, published_at = $13, updated_at = NOW()
       WHERE id = $14`,
      [
        title.trim(),
        slug.trim(),
        summary?.trim() || null,
        content.trim(),
        category.trim(),
        subcategory?.trim() || null,
        Array.isArray(tags) && tags.length > 0 ? tags : null,
        Array.isArray(keywords) && keywords.length > 0 ? keywords : null,
        authorName?.trim() || null,
        status,
        language?.trim() || "en",
        JSON.stringify(customData),
        publishedAt,
        id,
      ]
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    if (err.code === "23505") {
      return NextResponse.json(
        { error: "An article with this slug already exists" },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to update article" },
      { status: 500 }
    );
  }
}

async function DELETE_handler(request, { params }, authz) {
  const auth = requireAuth(authz);
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    await pool.query(`DELETE FROM kb_articles WHERE id = $1`, [id]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to delete article" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard; API-key callers keep their access.
export const GET = withPermission("kb_articles:read", GET_handler, { apiKey: requireAiApiKey, route: "/api/admin/kb-articles/[id]" });
export const PUT = withPermission("kb_articles:update", PUT_handler, { apiKey: requireAiApiKey, route: "/api/admin/kb-articles/[id]" });
export const DELETE = withPermission("kb_articles:delete", DELETE_handler, { apiKey: requireAiApiKey, route: "/api/admin/kb-articles/[id]" });

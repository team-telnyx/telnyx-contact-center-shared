import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { requireAiApiKey } from "@/app/api/_utils/ai-auth";
import { randomUUID } from "crypto";
import { normalizeCustomDataValue } from "@/lib/custom-data-utils";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

// Machine access (telnyx-ai-api-key) or an administrator session; the guard decides.
function requireAuth(authz) {
  return authz.apiKey ? { type: "api_key", user: null } : { type: "session", user: authz.user };
}

async function GET_handler(request, _context, authz) {
  const auth = requireAuth(authz);
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const pageSize = Math.max(
    1,
    parseInt(searchParams.get("pageSize") || "10", 10)
  );
  const offset = (page - 1) * pageSize;
  const statusFilter = searchParams.get("status");
  const categoryFilter = searchParams.get("category");
  const searchQuery = searchParams.get("q") || "";

  try {
    // Build WHERE clause
    const whereConditions = [];
    const queryParams = [];
    let paramIndex = 1;

    if (statusFilter && statusFilter !== "all") {
      whereConditions.push(`status = $${paramIndex}`);
      queryParams.push(statusFilter);
      paramIndex++;
    }

    if (categoryFilter && categoryFilter !== "all") {
      whereConditions.push(`category = $${paramIndex}`);
      queryParams.push(categoryFilter);
      paramIndex++;
    }

    if (searchQuery.trim()) {
      whereConditions.push(
        `(title ILIKE $${paramIndex} OR summary ILIKE $${paramIndex} OR content ILIKE $${paramIndex} OR EXISTS (SELECT 1 FROM unnest(tags) AS tag WHERE tag ILIKE $${paramIndex}) OR EXISTS (SELECT 1 FROM unnest(keywords) AS keyword WHERE keyword ILIKE $${paramIndex}))`
      );
      queryParams.push(`%${searchQuery.trim()}%`);
      paramIndex++;
    }

    const whereClause =
      whereConditions.length > 0
        ? `WHERE ${whereConditions.join(" AND ")}`
        : "";

    // Get total count
    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM kb_articles ${whereClause}`,
      queryParams
    );
    const total = parseInt(countRes.rows[0]?.total || "0", 10);

    // Get items
    queryParams.push(pageSize, offset);
    const itemsRes = await pool.query(
      `SELECT id, username, title, slug, summary, content, category, subcategory, tags, keywords, author_name, status, language, custom_data, published_at, created_at, updated_at
       FROM kb_articles
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      queryParams
    );

    return NextResponse.json({
      items: itemsRes.rows || [],
      total,
      page,
      pageSize,
    });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to load KB articles" },
      { status: 500 }
    );
  }
}

async function POST_handler(request, _context, authz) {
  const auth = requireAuth(authz);
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

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

    const id = randomUUID();
    const username = auth.user?.username || auth.user?.email || "ai-assistant";
    const publishedAt =
      status === "Published" ? new Date().toISOString() : null;

    await pool.query(
      `INSERT INTO kb_articles (id, username, title, slug, summary, content, category, subcategory, tags, keywords, author_name, status, language, custom_data, published_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())`,
      [
        id,
        username,
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
      ]
    );

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    if (err.code === "23505") {
      // Unique constraint violation (likely slug)
      return NextResponse.json(
        { error: "An article with this slug already exists" },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to create article" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard; API-key callers keep their access.
export const GET = withPermission("kb_articles:read", GET_handler, { apiKey: requireAiApiKey, route: "/api/admin/kb-articles" });
export const POST = withPermission("kb_articles:create", POST_handler, { apiKey: requireAiApiKey, route: "/api/admin/kb-articles" });

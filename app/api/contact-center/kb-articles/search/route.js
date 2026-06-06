export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";

/**
 * Search KB articles for contact center agents
 * This endpoint uses session authentication instead of API key
 */
export async function GET(request) {
  try {
    // Authenticate user with session
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Database not configured" },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const searchQuery = searchParams.get("q") || "";
    const pageSize = Math.min(
      10,
      Math.max(1, Number(searchParams.get("pageSize") || 5))
    );
    const status = searchParams.get("status") || "Published";

    if (!searchQuery) {
      return NextResponse.json({
        ok: true,
        rows: [],
        count: 0,
      });
    }

    // Build query with full-text search
    // All KB articles are shared among all users - no username filtering
    const where = [];
    const vals = [];
    let whereIdx = 1;

    // Full-text search using search_vector
    // Use plainto_tsquery for phrase matching (handles multiple words)
    // Fallback to ILIKE if search_vector is NULL (for articles inserted before trigger)
    where.push(`(
      search_vector @@ plainto_tsquery('english', $${whereIdx})
      OR (search_vector IS NULL AND (
        title ILIKE $${whereIdx + 1}
        OR summary ILIKE $${whereIdx + 1}
        OR content ILIKE $${whereIdx + 1}
        OR EXISTS (SELECT 1 FROM unnest(tags) AS tag WHERE tag ILIKE $${whereIdx + 1})
        OR EXISTS (SELECT 1 FROM unnest(keywords) AS keyword WHERE keyword ILIKE $${whereIdx + 1})
      ))
    )`);
    const searchPattern = `%${searchQuery}%`;
    vals.push(searchQuery, searchPattern);
    whereIdx += 2;

    // Add status filter
    if (status) {
      where.push(`status = $${whereIdx}`);
      vals.push(status);
      whereIdx++;
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Order by relevance using ts_rank (handle NULL search_vector)
    // For articles with search_vector, use ts_rank; for others, use 0
    const orderBy = `COALESCE(ts_rank(search_vector, plainto_tsquery('english', $${whereIdx})), 0) DESC, created_at DESC`;
    vals.push(searchQuery); // Reuse search query for ts_rank

    const sql = `
      SELECT 
        title, 
        slug, 
        summary, 
        content, 
        category, 
        subcategory, 
        language,
        author_name,
        published_at,
        tags,
        keywords
      FROM kb_articles 
      ${whereSql} 
      ORDER BY ${orderBy}
      LIMIT ${pageSize}
    `;

    const result = await pool.query(sql, vals);

    return NextResponse.json({
      ok: true,
      rows: result.rows || [],
      count: result.rows?.length || 0,
    });
  } catch (error) {
    console.error("[KB Articles Search] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}


import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { normalizeCustomDataValue } from "@/lib/custom-data-utils";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user) return null;
  if (!isAdmin(user)) return null;
  return user;
}

export async function GET(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
    console.error("[KB Articles] GET error:", err);
    return NextResponse.json(
      { error: "Failed to load article" },
      { status: 500 }
    );
  }
}

export async function PUT(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
    console.error("[KB Articles] PUT error:", err);
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

export async function DELETE(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
    console.error("[KB Articles] DELETE error:", err);
    return NextResponse.json(
      { error: "Failed to delete article" },
      { status: 500 }
    );
  }
}


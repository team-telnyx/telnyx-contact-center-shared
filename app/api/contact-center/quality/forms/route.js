import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { createDiagnosticLogger } from "@/lib/diagnostic-logger.mjs";

const qualityLogger = createDiagnosticLogger("contact-center.quality");

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * GET /api/contact-center/quality/forms
 * List quality evaluation forms (newest first). ?status=published filters.
 */
export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");

    const where = [];
    const vals = [];
    if (status && ["draft", "published", "archived"].includes(status)) {
      vals.push(status);
      where.push(`f.status = $${vals.length}`);
    } else {
      where.push(`f.status <> 'archived'`);
    }

    const result = await pool.query(
      `SELECT
         f.*,
         COALESCE(e.evaluation_count, 0)::int AS evaluation_count
       FROM quality_forms f
       LEFT JOIN (
         SELECT form_id, COUNT(*) AS evaluation_count
         FROM quality_evaluations
         GROUP BY form_id
       ) e ON e.form_id = f.id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY f.created_at DESC`,
      vals,
    );

    return NextResponse.json({ ok: true, forms: result.rows });
  } catch (error) {
    qualityLogger.error("quality_forms_list_failed", { error: error?.message });
    return NextResponse.json(
      { ok: false, error: "Failed to list quality forms" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/contact-center/quality/forms
 * Create a new quality evaluation form (draft).
 */
export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    }

    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) {
      return NextResponse.json({ ok: false, error: "Form name is required" }, { status: 400 });
    }

    const schema =
      body.schema && typeof body.schema === "object" ? body.schema : { sections: [] };
    const scoringConfig =
      body.scoring_config && typeof body.scoring_config === "object"
        ? body.scoring_config
        : { passThresholdPercent: 80, criticalFailZeroesScore: true };
    const aiPromptConfig =
      body.ai_prompt_config && typeof body.ai_prompt_config === "object"
        ? body.ai_prompt_config
        : {};

    let slug = slugify(body.slug || name);
    const slugCheck = await pool.query(
      "SELECT 1 FROM quality_forms WHERE slug = $1 LIMIT 1",
      [slug],
    );
    if (slugCheck.rows.length > 0) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    const result = await pool.query(
      `INSERT INTO quality_forms
         (name, slug, description, category, status, version, schema, scoring_config, ai_prompt_config, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'draft', 1, $5, $6, $7, $8, $8)
       RETURNING *`,
      [
        name,
        slug,
        body.description || null,
        body.category || null,
        JSON.stringify(schema),
        JSON.stringify(scoringConfig),
        JSON.stringify(aiPromptConfig),
        user.username || user.email || "unknown",
      ],
    );

    return NextResponse.json({ ok: true, form: result.rows[0] });
  } catch (error) {
    qualityLogger.error("quality_forms_create_failed", { error: error?.message });
    return NextResponse.json(
      { ok: false, error: "Failed to create quality form" },
      { status: 500 },
    );
  }
}

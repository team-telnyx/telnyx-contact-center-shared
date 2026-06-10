import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { createDiagnosticLogger } from "@/lib/diagnostic-logger.mjs";

const qualityLogger = createDiagnosticLogger("contact-center.quality");

async function guard() {
  const user = await getAuthenticatedUser();
  if (!user) {
    return { error: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }) };
  }
  if (!isSupervisorOrAdmin(user)) {
    return { error: NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 }) };
  }
  const pool = getPostgresPool();
  if (!pool) {
    return { error: NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 }) };
  }
  return { user, pool };
}

/**
 * GET /api/contact-center/quality/forms/[id]
 */
export async function GET(request, { params }) {
  try {
    const { error, pool } = await guard();
    if (error) return error;

    const { id } = (await params) || {};
    const result = await pool.query("SELECT * FROM quality_forms WHERE id = $1", [id]);
    if (!result.rows[0]) {
      return NextResponse.json({ ok: false, error: "Form not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, form: result.rows[0] });
  } catch (error) {
    qualityLogger.error("quality_form_get_failed", { error: error?.message });
    return NextResponse.json({ ok: false, error: "Failed to load form" }, { status: 500 });
  }
}

/**
 * PATCH /api/contact-center/quality/forms/[id]
 * Update name/description/schema/configs. Editing the schema of a published
 * form bumps the version and snapshots the previous version.
 */
export async function PATCH(request, { params }) {
  try {
    const { error, user, pool } = await guard();
    if (error) return error;

    const { id } = (await params) || {};
    const body = await request.json().catch(() => ({}));

    const existingRes = await pool.query("SELECT * FROM quality_forms WHERE id = $1", [id]);
    const existing = existingRes.rows[0];
    if (!existing) {
      return NextResponse.json({ ok: false, error: "Form not found" }, { status: 404 });
    }

    const updates = [];
    const vals = [];
    let idx = 1;

    const username = user.username || user.email || "unknown";
    const schemaChanged =
      body.schema && typeof body.schema === "object" &&
      JSON.stringify(body.schema) !== JSON.stringify(existing.schema);
    let nextVersion = existing.version;

    if (schemaChanged && existing.status === "published") {
      nextVersion = Number(existing.version || 1) + 1;
      await pool.query(
        `INSERT INTO quality_form_versions (form_id, version, schema, scoring_config, ai_prompt_config, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (form_id, version) DO NOTHING`,
        [
          id,
          nextVersion,
          JSON.stringify(body.schema),
          JSON.stringify(body.scoring_config || existing.scoring_config || {}),
          JSON.stringify(body.ai_prompt_config || existing.ai_prompt_config || {}),
          username,
        ],
      );
      updates.push(`version = $${idx++}`);
      vals.push(nextVersion);
    }

    for (const [key, column] of [
      ["name", "name"],
      ["description", "description"],
      ["category", "category"],
    ]) {
      if (body[key] !== undefined) {
        updates.push(`${column} = $${idx++}`);
        vals.push(body[key]);
      }
    }
    for (const [key, column] of [
      ["schema", "schema"],
      ["scoring_config", "scoring_config"],
      ["ai_prompt_config", "ai_prompt_config"],
    ]) {
      if (body[key] !== undefined && typeof body[key] === "object") {
        updates.push(`${column} = $${idx++}`);
        vals.push(JSON.stringify(body[key]));
      }
    }
    if (body.status && ["draft", "published", "archived"].includes(body.status)) {
      updates.push(`status = $${idx++}`);
      vals.push(body.status);
      if (body.status === "published") {
        updates.push(`published_at = NOW()`);
      }
    }

    if (!updates.length) {
      return NextResponse.json({ ok: true, form: existing });
    }

    updates.push(`updated_by = $${idx++}`);
    vals.push(username);
    updates.push(`updated_at = NOW()`);
    vals.push(id);

    const result = await pool.query(
      `UPDATE quality_forms SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
      vals,
    );

    return NextResponse.json({ ok: true, form: result.rows[0] });
  } catch (error) {
    qualityLogger.error("quality_form_update_failed", { error: error?.message });
    return NextResponse.json({ ok: false, error: "Failed to update form" }, { status: 500 });
  }
}

/**
 * DELETE /api/contact-center/quality/forms/[id]
 * Archives the form (soft delete) so historical evaluations keep their reference.
 */
export async function DELETE(request, { params }) {
  try {
    const { error, user, pool } = await guard();
    if (error) return error;

    const { id } = (await params) || {};
    const result = await pool.query(
      `UPDATE quality_forms
       SET status = 'archived', updated_by = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, user.username || user.email || "unknown"],
    );
    if (!result.rows[0]) {
      return NextResponse.json({ ok: false, error: "Form not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, form: result.rows[0] });
  } catch (error) {
    qualityLogger.error("quality_form_archive_failed", { error: error?.message });
    return NextResponse.json({ ok: false, error: "Failed to archive form" }, { status: 500 });
  }
}

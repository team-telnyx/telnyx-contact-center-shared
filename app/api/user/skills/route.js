import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

/**
 * GET /api/user/skills
 * Get current user's skills
 */
async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 }
      );
    }

    // Get user's skills from database
    const result = await pool.query(`SELECT skills FROM users WHERE id = $1`, [
      user.id,
    ]);

    if (!result.rows || result.rows.length === 0) {
      return NextResponse.json({ ok: true, skills: {} });
    }

    // Parse skills JSONB field
    let skills = {};
    const skillsRaw = result.rows[0].skills;
    if (skillsRaw) {
      if (typeof skillsRaw === "string") {
        try {
          skills = JSON.parse(skillsRaw);
        } catch {
          skills = {};
        }
      } else if (typeof skillsRaw === "object") {
        skills = skillsRaw;
      }
    }

    // Resolve only this user's assigned skills; no admin catalogue permission is needed.
    const ids = Object.keys(skills);
    const items = ids.length ? (await pool.query(
      "SELECT id, name, description, category FROM skills WHERE id::text = ANY($1::text[]) ORDER BY name",
      [ids],
    )).rows.map(item => ({ ...item, level: skills[String(item.id)] })) : [];
    return NextResponse.json({ ok: true, skills, items });
  } catch (err) {
    platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("authenticated", GET_handler, { route: "/api/user/skills" });

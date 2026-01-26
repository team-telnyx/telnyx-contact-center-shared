import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";

/**
 * GET /api/user/skills
 * Get current user's skills
 */
export async function GET(request) {
  try {
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

    return NextResponse.json({ ok: true, skills });
  } catch (err) {
    console.error("[UserSkills] GET error", err);
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}

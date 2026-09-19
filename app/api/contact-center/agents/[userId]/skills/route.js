import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { agentInScope } from "@/lib/authz/scope.mjs";

/**
 * GET /api/contact-center/agents/[userId]/skills
 * Get agent's skills with skill names (converted from UUIDs)
 */
async function GET_handler(request, { params }, authz) {
  try {
    const user = authz.user;

    // Only supervisors and admins can view agent skills

    const { userId } = await params;
    if (userId && !agentInScope(authz.scope, userId)) {
      return NextResponse.json({ ok: false, error: "Agent not found" }, { status: 404 });
    }
    if (!userId) {
      return NextResponse.json(
        { ok: false, error: "User ID is required" },
        { status: 400 },
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 },
      );
    }

    // Get user with skills
    const userResult = await pool.query(
      `SELECT id, username, first_name, last_name, skills FROM users WHERE id = $1`,
      [userId],
    );

    if (userResult.rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "User not found" },
        { status: 404 },
      );
    }

    const userData = userResult.rows[0];

    // Load skills mapping (UUID to name)
    const skillsResult = await pool.query(
      `SELECT id, name FROM skills WHERE is_active = true`,
    );
    const skillsMapping = new Map();
    skillsResult.rows.forEach((row) => {
      skillsMapping.set(row.id, row.name);
    });

    // Helper function to safely parse JSONB skills
    const safeParse = (value) => {
      if (!value) return {};
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return {};
        }
      }
      return value || {};
    };

    // Convert agent skills from UUID keys to name keys
    const agentSkillsRaw = safeParse(userData.skills);
    const agentSkills = {};
    for (const [skillId, proficiency] of Object.entries(agentSkillsRaw)) {
      const skillName = skillsMapping.get(skillId);
      if (skillName) {
        agentSkills[skillName] = proficiency;
      }
    }

    return NextResponse.json({
      ok: true,
      agent: {
        id: userData.id,
        username: userData.username,
        firstName: userData.first_name,
        lastName: userData.last_name,
        skills: agentSkills,
      },
    });
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: "Failed to fetch agent skills" },
      { status: 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agents:read", GET_handler, { route: "/api/contact-center/agents/[userId]/skills" });

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { isSupervisorOrAdmin } from "@/lib/role-utils";

function safeParse(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export async function GET(request, context) {
  try {
    const params = await context?.params;
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 }
      );
    }

    const { id } = params || {};
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
        { status: 400 }
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 }
      );
    }

    const result = await pool.query(
      `SELECT i.*, u.first_name, u.last_name
       FROM cc_interactions i
       LEFT JOIN users u ON i.agent_username = u.username
       WHERE i.id = $1
       LIMIT 1`,
      [id]
    );

    const row = result.rows?.[0];
    if (!row) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 }
      );
    }

    const wrapupCodes = safeParse(row.wrapup_codes) || [];
    let wrapupCodeNames = [];
    if (Array.isArray(wrapupCodes) && wrapupCodes.length > 0) {
      const wrapupRes = await pool.query(
        `SELECT id, name
         FROM cc_wrapup_codes
         WHERE id = ANY($1::text[])
         ORDER BY display_order ASC, name ASC`,
        [wrapupCodes]
      );
      wrapupCodeNames = (wrapupRes.rows || []).map((code) => code.name);
    }

    const interaction = {
      ...row,
      agent_name:
        row.first_name || row.last_name
          ? `${row.first_name || ""} ${row.last_name || ""}`.trim()
          : row.agent_username || null,
      required_skills: safeParse(row.required_skills),
      routing_metadata: safeParse(row.routing_metadata),
      transfer_history: safeParse(row.transfer_history),
      tags: safeParse(row.tags),
      wrapup_codes: wrapupCodes,
      wrapup_code_names: wrapupCodeNames,
      metadata: safeParse(row.metadata),
    };

    return NextResponse.json({ ok: true, interaction });
  } catch (error) {
    console.error("[InteractionDetail] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Failed to fetch interaction" },
      { status: 500 }
    );
  }
}


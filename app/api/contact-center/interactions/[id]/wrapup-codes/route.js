export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";

async function getUsernameForUserId(userId) {
  const pool = getPostgresPool();
  if (!pool) return null;
  const userResult = await pool.query(
    "SELECT username FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );
  return userResult.rows?.[0]?.username || null;
}

async function getQueueWrapupCodes(queueId) {
  const pool = getPostgresPool();
  if (!pool) return { codes: [], defaultCode: null };

  const [codesRes, defaultRes] = await Promise.all([
    pool.query(
      `SELECT w.id, w.name, w.is_default, w.description, w.icon, w.color
       FROM cc_queue_wrapup_codes qwc
       JOIN cc_wrapup_codes w ON qwc.wrapup_code_id = w.id
       WHERE qwc.queue_id = $1 AND w.is_active = true
       ORDER BY w.display_order ASC, w.name ASC`,
      [queueId],
    ),
    pool.query(
      `SELECT id, name, icon, color
       FROM cc_wrapup_codes
       WHERE is_active = true AND is_default = true
       ORDER BY display_order ASC, name ASC
       LIMIT 1`,
    ),
  ]);

  const codes = codesRes.rows || [];
  const defaultCode = defaultRes.rows?.[0] || null;
  return { codes, defaultCode };
}

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
        { status: 400 },
      );
    }

    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const interaction = await PgDb.findInteractionById(id);
    if (!interaction) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 },
      );
    }

    if (interaction.agent_username) {
      const username = await getUsernameForUserId(user.id);
      if (username && interaction.agent_username !== username) {
        return NextResponse.json(
          {
            ok: false,
            error: "Unauthorized - interaction belongs to different agent",
          },
          { status: 403 },
        );
      }
    }

    if (!interaction.queue_id) {
      return NextResponse.json({
        ok: true,
        queueId: null,
        queueName: interaction.queue_name || null,
        codes: [],
        defaultCodeId: null,
      });
    }

    const { codes, defaultCode } = await getQueueWrapupCodes(
      interaction.queue_id,
    );

    if (codes.length === 0 && defaultCode) {
      codes.push({
        id: defaultCode.id,
        name: defaultCode.name,
        is_default: true,
        description: "",
        icon: defaultCode.icon || null,
        color: defaultCode.color || null,
      });
    }

    // Check if this is a timeout re-enqueue scenario
    const metadata = interaction.metadata || {};
    const wasTimeoutReEnqueued = metadata.timeout_re_enqueued === true;

    return NextResponse.json({
      ok: true,
      queueId: interaction.queue_id,
      queueName: interaction.queue_name || null,
      codes,
      defaultCodeId: defaultCode?.id || null,
      selectedCodes: interaction.wrapup_codes || [],
      timeoutReEnqueued: wasTimeoutReEnqueued,
      metadata: metadata,
    });
  } catch (err) {
    console.error("[WrapupCodes] GET error:", err);
    return NextResponse.json(
      { ok: false, error: "Failed to load wrapup codes" },
      { status: 500 },
    );
  }
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
        { status: 400 },
      );
    }

    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const interaction = await PgDb.findInteractionById(id);
    if (!interaction) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 },
      );
    }

    if (interaction.agent_username) {
      const username = await getUsernameForUserId(user.id);
      if (username && interaction.agent_username !== username) {
        return NextResponse.json(
          {
            ok: false,
            error: "Unauthorized - interaction belongs to different agent",
          },
          { status: 403 },
        );
      }
    }

    const body = await request.json();
    const providedCodes = Array.isArray(body.wrapupCodes)
      ? body.wrapupCodes
      : [];

    let allowedCodes = [];
    let defaultCodeId = null;
    if (interaction.queue_id) {
      const { codes, defaultCode } = await getQueueWrapupCodes(
        interaction.queue_id,
      );
      allowedCodes = (codes || []).map((c) => c.id);
      defaultCodeId = defaultCode?.id || null;
    }

    let finalCodes = providedCodes.filter((codeId) =>
      allowedCodes.includes(codeId),
    );
    if (finalCodes.length === 0 && defaultCodeId) {
      finalCodes = [defaultCodeId];
    }

    await PgDb.updateInteractionById(id, {
      wrapupCodes: finalCodes,
    });

    return NextResponse.json({ ok: true, wrapupCodes: finalCodes });
  } catch (err) {
    console.error("[WrapupCodes] POST error:", err);
    return NextResponse.json(
      { ok: false, error: "Failed to save wrapup codes" },
      { status: 500 },
    );
  }
}

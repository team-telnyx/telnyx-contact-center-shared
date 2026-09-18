import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { effectiveAgentStatusSql } from "@/lib/acd/agent-state.mjs";
import { withPermission } from "@/lib/authz/guard";

/**
 * GET /api/user/contacts
 * Get contacts, users, and assistants for the logged-in user
 */
async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;

    const username = user.username || user.email;
    if (!username) {
      return NextResponse.json(
        { ok: false, error: "User not found" },
        { status: 404 }
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Database not configured" },
        { status: 500 }
      );
    }

    // Fetch contacts (all contacts, not filtered by username since contacts are shared)
    // Filter to only include contacts with phone numbers
    const contactsRes = await pool.query(
      `SELECT * FROM contacts 
       WHERE deleted_at IS NULL 
       AND (phone IS NOT NULL AND phone != '' 
            OR mobile IS NOT NULL AND mobile != ''
            OR business_phone_1 IS NOT NULL AND business_phone_1 != ''
            OR business_phone_2 IS NOT NULL AND business_phone_2 != ''
            OR home_phone_1 IS NOT NULL AND home_phone_1 != ''
            OR home_phone_2 IS NOT NULL AND home_phone_2 != '')
       ORDER BY last_interaction_at DESC NULLS LAST, created_at DESC`
    );

    // Split contacts into customers and patients based on category field if it exists
    // For now, treat all contacts as customers (can be enhanced later with category field)
    const customers = contactsRes.rows || [];
    const patients = []; // Empty for now, can be populated if category field is added

    // Fetch registered users with phone numbers
    const effectiveStatus = effectiveAgentStatusSql("ast");
    const usersRes = await pool.query(
      `SELECT u.id, u.username, u.first_name, u.last_name, u.nick, u.mobile, u.voice_number,
              u.telephony_user_name, u.profile_picture_uri, ${effectiveStatus} AS agent_status
       FROM users u
       LEFT JOIN acd_agent_state ast ON ast.agent_id = u.id
       WHERE (u.mobile IS NOT NULL AND u.mobile != '')
          OR (u.voice_number IS NOT NULL AND u.voice_number != '')
          OR (u.telephony_user_name IS NOT NULL AND u.telephony_user_name != '')
       ORDER BY u.first_name, u.last_name, u.username`
    );

    // Fetch assistants from Telnyx API
    let assistants = [];
    try {
      const apiKey = process.env.TELNYX_API_KEY;
      if (apiKey) {
        const assistantsRes = await fetch(buildTelnyxV2Url("/ai/assistants"), {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          cache: "no-store",
        });
        if (assistantsRes.ok) {
          const assistantsData = await assistantsRes.json();
          assistants = Array.isArray(assistantsData?.data)
            ? assistantsData.data
            : [];
        }
      }
    } catch (err) {
      platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    }

    return NextResponse.json({
      ok: true,
      customers: customers,
      patients: patients,
      users: usersRes.rows || [],
      assistants: assistants,
    });
  } catch (err) {
    platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("authenticated", GET_handler, { route: "/api/user/contacts" });

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { PgDb } from "@/lib/pgdb";

/**
 * GET /api/contact-center/interactions/by-call-control-id?callControlId=...
 * Find interaction by call_control_id
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

    const { searchParams } = new URL(request.url);
    const callControlId = searchParams.get("callControlId");

    if (!callControlId || callControlId.trim() === "") {
      return NextResponse.json(
        { ok: false, error: "callControlId is required" },
        { status: 400 }
      );
    }

    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        callControlId
      );

    // Simple lookup by call_control_id
    let interaction = await PgDb.findInteractionByCallControlId(callControlId);

    // If callControlId looks like a call_session_id, try direct lookup
    if (!interaction && isUuid) {
      try {
        const { getPostgresPool } = await import("@/lib/postgres.mjs");
        const pool = getPostgresPool();
        if (pool) {
          const result = await pool.query(
            `SELECT * FROM cc_interactions
             WHERE call_session_id = $1
               AND is_contact_center = true
             ORDER BY created_at ASC
             LIMIT 1`,
            [callControlId]
          );
          if (result.rows?.[0]) {
            const row = result.rows[0];
            const safeParse = (value) => {
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
            };
            interaction = {
              ...row,
              required_skills: safeParse(row.required_skills),
              routing_metadata: safeParse(row.routing_metadata),
              transfer_history: safeParse(row.transfer_history),
              tags: safeParse(row.tags),
              wrapup_codes: safeParse(row.wrapup_codes),
              metadata: safeParse(row.metadata),
            };
          }
        }
      } catch (err) {
        console.warn(
          "[FindInteractionByCallControlId] Error looking up by call_session_id:",
          err
        );
      }
    }

    // If not found by call_control_id, check the incoming call store for mapping
    // This handles the case where the WebRTC client has a different call_control_id
    // than the original incoming call (e.g., when transferred to agent via WebRTC)
    if (!interaction) {
      try {
        const { getIncomingCallData } = await import(
          "@/lib/incoming-call-store"
        );
        const callData = getIncomingCallData(callControlId);

        if (callData?.originalCallControlId) {
          interaction = await PgDb.findInteractionByCallControlId(
            callData.originalCallControlId
          );
        }
      } catch (err) {
        console.warn(
          "[FindInteractionByCallControlId] Error checking incoming call store:",
          err
        );
      }
    }

    // If still not found, try metadata call_control_id fields
    if (!interaction) {
      try {
        const { getPostgresPool } = await import("@/lib/postgres.mjs");
        const pool = getPostgresPool();
        if (pool) {
          const result = await pool.query(
            `SELECT * FROM cc_interactions
             WHERE is_contact_center = true
               AND (
                 metadata->>'original_call_control_id' = $1
                 OR metadata->>'agent_call_control_id' = $1
               )
             ORDER BY created_at DESC
             LIMIT 1`,
            [callControlId]
          );
          if (result.rows?.[0]) {
            const row = result.rows[0];
            const safeParse = (value) => {
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
            };
            interaction = {
              ...row,
              required_skills: safeParse(row.required_skills),
              routing_metadata: safeParse(row.routing_metadata),
              transfer_history: safeParse(row.transfer_history),
              tags: safeParse(row.tags),
              wrapup_codes: safeParse(row.wrapup_codes),
              metadata: safeParse(row.metadata),
            };
          }
        }
      } catch (err) {
        console.warn(
          "[FindInteractionByCallControlId] Error looking up by metadata call_control_id:",
          err
        );
      }
    }

    // If still not found, try looking up by call_session_id
    // All call legs in a session share the same call_session_id
    if (!interaction) {
      try {
        // Find an interaction that has this call_control_id in metadata
        // or has the same call_session_id
        const { getPostgresPool } = await import("@/lib/postgres.mjs");
        const pool = getPostgresPool();
        if (pool) {
          // Try to find by call_session_id from any interaction with matching session
          const result = await pool.query(
            `SELECT * FROM cc_interactions 
             WHERE call_session_id IN (
               SELECT call_session_id FROM cc_interactions 
               WHERE call_control_id = $1 
               LIMIT 1
             )
             AND is_contact_center = true
             ORDER BY created_at ASC
             LIMIT 1`,
            [callControlId]
          );
          if (result.rows?.[0]) {
            const row = result.rows[0];
            // Parse JSON fields
            const safeParse = (value) => {
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
            };
            interaction = {
              ...row,
              required_skills: safeParse(row.required_skills),
              routing_metadata: safeParse(row.routing_metadata),
              transfer_history: safeParse(row.transfer_history),
              tags: safeParse(row.tags),
              wrapup_codes: safeParse(row.wrapup_codes),
              metadata: safeParse(row.metadata),
            };
          }
        }
      } catch (err) {
        console.warn(
          "[FindInteractionByCallControlId] Error looking up by call_session_id:",
          err
        );
      }
    }

    return NextResponse.json({
      ok: true,
      interaction: interaction || null,
    });
  } catch (err) {
    console.error("[FindInteractionByCallControlId] Error:", err);
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}

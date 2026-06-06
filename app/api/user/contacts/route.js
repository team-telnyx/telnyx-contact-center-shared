import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildTelnyxV2Url } from "@/lib/telnyx";

/**
 * GET /api/user/contacts
 * Get contacts, users, and assistants for the logged-in user
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
    const usersRes = await pool.query(
      `SELECT id, username, first_name, last_name, nick, mobile, voice_number, telephony_user_name, profile_picture_uri
       FROM users 
       WHERE (mobile IS NOT NULL AND mobile != '') 
          OR (voice_number IS NOT NULL AND voice_number != '')
          OR (telephony_user_name IS NOT NULL AND telephony_user_name != '')
       ORDER BY first_name, last_name, username`
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
      console.error("[USER] Failed to fetch assistants:", err);
    }

    return NextResponse.json({
      ok: true,
      customers: customers,
      patients: patients,
      users: usersRes.rows || [],
      assistants: assistants,
    });
  } catch (err) {
    console.error("[USER] Contacts GET error", err);
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}

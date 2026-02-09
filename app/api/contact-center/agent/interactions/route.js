import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { PgDb } from "@/lib/pgdb";

/**
 * GET /api/contact-center/agent/interactions
 * List active interactions assigned to agent from cc_interactions table
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
    const state = searchParams.get("state");
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const activeOnly = searchParams.get("activeOnly") !== "false";

    console.log(`[API agent/interactions] Fetching for user: ${user.username}, activeOnly: ${activeOnly}`);
    
    // Fetch interactions from database
    const interactions = await PgDb.listAgentInteractions(user.username, {
      state, // If state filter is provided, use it
      activeOnly, // Only fetch non-completed interactions if activeOnly is true
      limit,
    });

    console.log(`[API agent/interactions] Found ${interactions.length} interactions`);
    
    // DEBUG: Log metadata for each interaction
    interactions.forEach((interaction, idx) => {
      console.log(`[API agent/interactions] interaction[${idx}].id:`, interaction.id);
      console.log(`[API agent/interactions] interaction[${idx}].state:`, interaction.state);
      console.log(`[API agent/interactions] interaction[${idx}].metadata:`, JSON.stringify(interaction.metadata));
    });

    // Only return interactions from cc_interactions table
    return NextResponse.json({ ok: true, interactions });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}


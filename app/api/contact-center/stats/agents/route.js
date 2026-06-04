/**
 * API endpoint for agent statistics
 * GET /api/contact-center/stats/agents?userId=xxx
 */

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getAgentStatistics } from "@/lib/contact-center/stats-aggregator";
import { isAdmin } from "@/lib/role-utils";

export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    // Admins can see all agents, agents can only see their own stats
    let stats;
    if (userId) {
      if (!isAdmin(user) && userId !== user.id) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      stats = await getAgentStatistics(userId);
    } else {
      if (!isAdmin(user)) {
        // Agents can only see their own stats
        stats = await getAgentStatistics(user.id);
      } else {
        stats = await getAgentStatistics();
      }
    }

    return NextResponse.json({
      stats: Array.isArray(stats) ? stats : [stats].filter(Boolean),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Stats] Error getting agent statistics:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error.message,
      },
      { status: 500 }
    );
  }
}

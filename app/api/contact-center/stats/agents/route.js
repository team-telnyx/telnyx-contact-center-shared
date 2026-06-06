/**
 * API endpoint for agent statistics
 * GET /api/contact-center/stats/agents?userId=xxx
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getAgentStatistics } from "@/lib/contact-center/stats-aggregator";
import { isAdmin } from "@/lib/role-utils";
import { PgDb } from "@/lib/pgdb";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    // Get user to check permissions
    const user = await PgDb.findUserById(session.user.id);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Admins can see all agents, agents can only see their own stats
    let stats;
    if (userId) {
      if (!isAdmin(user) && userId !== session.user.id) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      stats = await getAgentStatistics(userId);
    } else {
      if (!isAdmin(user)) {
        // Agents can only see their own stats
        stats = await getAgentStatistics(session.user.id);
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

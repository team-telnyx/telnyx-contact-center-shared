/**
 * API endpoint for user dashboard statistics
 * GET /api/dashboard/stats
 * Returns user-specific dashboard metrics and charts data
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getAgentStatistics } from "@/lib/contact-center/stats-aggregator";
import { PgDb } from "@/lib/pgdb";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await PgDb.findUserById(session.user.id);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database connection unavailable" },
        { status: 500 }
      );
    }

    // Get period from query parameter (default: 'today')
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "today";

    // Calculate date range based on period
    let dateCondition;
    let dateParams = [];

    switch (period) {
      case "7days":
        dateCondition = "DATE(created_at) >= CURRENT_DATE - INTERVAL '7 days'";
        break;
      case "30days":
        dateCondition = "DATE(created_at) >= CURRENT_DATE - INTERVAL '30 days'";
        break;
      case "today":
      default:
        dateCondition = "DATE(created_at) = CURRENT_DATE";
        break;
    }

    const username = user.username;

    // Get calls by hour for selected period (for bar chart)
    const hourlyQuery = `
      SELECT
        EXTRACT(HOUR FROM created_at) as hour,
        COUNT(*) as call_count,
        COUNT(*) FILTER (WHERE state = 'completed') as completed_count,
        COUNT(*) FILTER (WHERE state = 'abandoned') as abandoned_count
      FROM cc_interactions
      WHERE agent_username = $1
        AND ${dateCondition}
        AND state IN ('completed', 'abandoned')
      GROUP BY EXTRACT(HOUR FROM created_at)
      ORDER BY hour ASC
    `;

    const hourlyResult = await pool.query(hourlyQuery, [username]);
    const hourlyActivity = hourlyResult.rows.map((row) => ({
      hour: parseInt(row.hour),
      hourLabel: `${String(parseInt(row.hour)).padStart(2, "0")}:00`,
      total: parseInt(row.call_count) || 0,
      completed: parseInt(row.completed_count) || 0,
      abandoned: parseInt(row.abandoned_count) || 0,
    }));

    // Get calls by queue for selected period (for pie/bar chart)
    const queueQuery = `
      SELECT
        q.display_name as queue_name,
        q.name as queue_id,
        COUNT(*) as call_count,
        COUNT(*) FILTER (WHERE i.state = 'completed') as completed_count,
        COUNT(*) FILTER (WHERE i.state = 'abandoned') as abandoned_count
      FROM cc_interactions i
      LEFT JOIN cc_queues q ON q.id = i.queue_id
      WHERE i.agent_username = $1
        AND ${dateCondition.replace('created_at', 'i.created_at')}
        AND i.state IN ('completed', 'abandoned')
      GROUP BY q.display_name, q.name, q.id
      ORDER BY call_count DESC
      LIMIT 10
    `;

    const queueResult = await pool.query(queueQuery, [username]);
    const queueDistribution = queueResult.rows.map((row) => ({
      queueName: row.queue_name || row.queue_id || "Unknown",
      queueId: row.queue_id || "unknown",
      total: parseInt(row.call_count) || 0,
      completed: parseInt(row.completed_count) || 0,
      abandoned: parseInt(row.abandoned_count) || 0,
    }));

    // Get aggregated stats for the selected period
    const statsQuery = `
      SELECT
        COUNT(*) as total_calls,
        COUNT(*) FILTER (WHERE state = 'completed') as completed_calls,
        COUNT(*) FILTER (WHERE state = 'abandoned') as abandoned_calls,
        AVG(wait_time_seconds)::NUMERIC(10,2) as avg_wait_time_seconds,
        AVG(handle_time_seconds)::NUMERIC(10,2) as avg_handle_time_seconds,
        AVG(talk_time_seconds)::NUMERIC(10,2) as avg_talk_time_seconds,
        SUM(talk_time_seconds) as total_talk_time_seconds
      FROM cc_interactions
      WHERE agent_username = $1
        AND ${dateCondition}
        AND state IN ('completed', 'abandoned')
    `;

    const statsResult = await pool.query(statsQuery, [username]);
    const stats = statsResult.rows[0] || {};

    // Get user's agent statistics for real-time data
    const agentStats = await getAgentStatistics(session.user.id);

    // Get performance distribution (completed vs abandoned)
    const performanceDistribution = [
      {
        name: "Completed",
        value: parseInt(stats.completed_calls) || 0,
        color: "#10b981", // emerald-500
      },
      {
        name: "Abandoned",
        value: parseInt(stats.abandoned_calls) || 0,
        color: "#ef4444", // red-500
      },
    ];

    return NextResponse.json({
      metrics: {
        totalCalls: parseInt(stats.total_calls) || 0,
        completedCalls: parseInt(stats.completed_calls) || 0,
        abandonedCalls: parseInt(stats.abandoned_calls) || 0,
        avgHandleTime: Math.round(parseFloat(stats.avg_handle_time_seconds) || 0),
        avgTalkTime: Math.round(parseFloat(stats.avg_talk_time_seconds) || 0),
        avgWaitTime: Math.round(parseFloat(stats.avg_wait_time_seconds) || 0),
        totalTalkTime: Math.round(parseInt(stats.total_talk_time_seconds) || 0),
        currentCalls: agentStats?.currentCalls || 0,
        status: agentStats?.status || "Offline",
      },
      charts: {
        performanceDistribution,
        hourlyActivity,
        queueDistribution,
      },
      period,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Dashboard] Error getting dashboard stats:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error.message,
      },
      { status: 500 }
    );
  }
}


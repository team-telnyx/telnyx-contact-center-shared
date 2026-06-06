import { NextResponse } from "next/server";
import { checkPostgresStatus } from "@/lib/postgres.mjs";

export async function GET() {
  try {
    // Check database connection
    const dbStatus = await checkPostgresStatus();

    if (!dbStatus.ready) {
      return NextResponse.json(
        {
          status: "unhealthy",
          database: "disconnected",
          error: dbStatus.error,
        },
        { status: 503 }
      );
    }

    return NextResponse.json({
      status: "healthy",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "unhealthy",
        error: error.message,
      },
      { status: 503 }
    );
  }
}

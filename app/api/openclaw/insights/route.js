import { NextResponse } from "next/server";

export async function GET() {
  // Mock data — no database tables needed
  const now = new Date();
  const insights = {
    sessionsToday: 42,
    skillsInstalled: 7,
    uptimeHours: 168,
    activeAutomations: 3,
    usageOverTime: Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (6 - i));
      return {
        date: d.toISOString().slice(0, 10),
        sessions: Math.floor(Math.random() * 60) + 10,
        automations: Math.floor(Math.random() * 10) + 1,
      };
    }),
  };
  return NextResponse.json(insights);
}

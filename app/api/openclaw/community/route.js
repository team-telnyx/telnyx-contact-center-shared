import { NextResponse } from "next/server";

const COMMUNITY = {
  popularSkills: [
    { name: "Telnyx TTS", author: "Telnyx", installs: 1240 },
    { name: "Call Summarizer", author: "OpenClaw", installs: 834 },
    { name: "Telnyx STT", author: "Telnyx", installs: 980 },
  ],
  recentAdditions: [
    { name: "Whisper Coach", author: "Telnyx", addedAt: "2026-02-15" },
    { name: "Queue Optimizer", author: "Community", addedAt: "2026-02-10" },
    { name: "CRM Connector", author: "Community", addedAt: "2026-02-05" },
  ],
  stats: {
    totalSkills: 8,
    totalAuthors: 3,
    totalInstalls: 5779,
  },
};

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const sort = searchParams.get("sort");

  if (type === "skills" && sort === "popular") {
    return NextResponse.json(COMMUNITY.popularSkills);
  }
  return NextResponse.json(COMMUNITY);
}

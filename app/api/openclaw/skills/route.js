import { NextResponse } from "next/server";

const SKILLS = [
  { id: "1", name: "Telnyx TTS", description: "High-quality text-to-speech using Telnyx AI voices with multi-language support.", author: "Telnyx", installs: 1240, category: "Voice", url: "https://clawhub.ai/" },
  { id: "2", name: "Telnyx STT", description: "Speech-to-text transcription powered by Deepgram Nova 2 via Telnyx.", author: "Telnyx", installs: 980, category: "Voice", url: "https://clawhub.ai/" },
  { id: "3", name: "Smart Router", description: "AI-powered call routing that learns from historical patterns.", author: "OpenClaw", installs: 756, category: "Routing", url: "https://clawhub.ai/" },
  { id: "4", name: "Sentiment Analyzer", description: "Real-time sentiment analysis during customer calls.", author: "OpenClaw", installs: 612, category: "AI", url: "https://clawhub.ai/" },
  { id: "5", name: "Queue Optimizer", description: "Automatically adjusts queue priorities based on wait times and SLA targets.", author: "Community", installs: 445, category: "Routing", url: "https://clawhub.ai/" },
  { id: "6", name: "CRM Connector", description: "Integrates with popular CRM systems for automatic customer lookup.", author: "Community", installs: 389, category: "Integration", url: "https://clawhub.ai/" },
  { id: "7", name: "Call Summarizer", description: "Generates AI summaries of completed calls for agent notes.", author: "OpenClaw", installs: 834, category: "AI", url: "https://clawhub.ai/" },
  { id: "8", name: "Whisper Coach", description: "Real-time coaching suggestions for agents during live calls.", author: "Telnyx", installs: 523, category: "AI", url: "https://clawhub.ai/" },
];

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sort = searchParams.get("sort");
  const search = searchParams.get("search")?.toLowerCase();

  let skills = [...SKILLS];
  if (search) {
    skills = skills.filter(
      (s) => s.name.toLowerCase().includes(search) || s.description.toLowerCase().includes(search) || s.category.toLowerCase().includes(search)
    );
  }
  if (sort === "popular") {
    skills.sort((a, b) => b.installs - a.installs);
  }
  return NextResponse.json(skills);
}

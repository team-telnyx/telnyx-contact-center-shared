import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { hasRole } from "@/lib/role-utils";
import { interactionsLogger, callPayload, agentPayload, contactCenterErrorPayload } from "@/lib/contact-center/logging.mjs";

function calculateSummary(transcriptions) {
  if (!Array.isArray(transcriptions) || transcriptions.length === 0) {
    return {
      topIntent: null,
      intentCount: 0,
      topTags: [],
      currentSentiment: "neutral",
      currentScore: 50,
      averageSentiment: "neutral",
      averageScore: 50,
    };
  }

  const latest = transcriptions[transcriptions.length - 1];
  const currentSentiment = latest.sentiment || "neutral";
  const currentScore =
    typeof latest.sentimentScore === "number" ? latest.sentimentScore : 50;

  const scores = transcriptions
    .map((t) => t.sentimentScore)
    .filter((v) => typeof v === "number");
  const averageScore =
    scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 50;
  let averageSentiment = "neutral";
  if (averageScore > 60) averageSentiment = "positive";
  if (averageScore < 40) averageSentiment = "negative";

  const intentCounts = new Map();
  const tagCounts = new Map();
  for (const item of transcriptions) {
    if (item.intent) {
      intentCounts.set(item.intent, (intentCounts.get(item.intent) || 0) + 1);
    }
    if (Array.isArray(item.tags)) {
      for (const tag of item.tags) {
        if (!tag) continue;
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
  }

  let topIntent = null;
  let intentCount = 0;
  for (const [intent, count] of intentCounts.entries()) {
    if (count > intentCount) {
      intentCount = count;
      topIntent = intent;
    }
  }

  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);

  return {
    topIntent,
    intentCount,
    topTags,
    currentSentiment,
    currentScore,
    averageSentiment,
    averageScore,
  };
}

export async function POST(request, { params }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasRole(user, ["agent", "supervisor", "admin", "owner"])) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 }
      );
    }

    const resolvedParams = (await params) || {};
    const { id } = resolvedParams;
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const transcriptions = Array.isArray(body.transcriptions)
      ? body.transcriptions
      : [];
    const summary = body.summary || calculateSummary(transcriptions);

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 }
      );
    }

    const interactionRes = await pool.query(
      "SELECT metadata FROM cc_interactions WHERE id = $1 LIMIT 1",
      [id]
    );
    if (!interactionRes.rows?.[0]) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 }
      );
    }

    let metadata = interactionRes.rows[0].metadata;
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = {};
      }
    }
    if (!metadata || typeof metadata !== "object") metadata = {};

    // Merge with existing agent_assist data (preserve suggestions from workflow mode)
    const existingAgentAssist = metadata.agent_assist || {};
    metadata.agent_assist = {
      ...existingAgentAssist,
      transcriptions,
      summary,
      updated_at: new Date().toISOString(),
    };

    await pool.query(
      "UPDATE cc_interactions SET metadata = $1, updated_at = NOW() WHERE id = $2",
      [JSON.stringify(metadata), id]
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    interactionsLogger.error("interaction_error_0", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof hangupError !== "undefined" ? hangupError : typeof e !== "undefined" ? e : undefined) });
    return NextResponse.json(
      { ok: false, error: "Failed to store transcription data" },
      { status: 500 }
    );
  }
}


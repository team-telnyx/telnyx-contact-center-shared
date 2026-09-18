import { randomUUID } from "node:crypto";
import { mergeAgentAssistTranscriptions } from "./history-merge.mjs";

export function calculateAgentAssistTranscriptSummary(transcriptions) {
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
    .map((item) => item.sentimentScore)
    .filter((value) => typeof value === "number");
  const averageScore = scores.length
    ? Math.round(scores.reduce((total, value) => total + value, 0) / scores.length)
    : 50;
  const averageSentiment =
    averageScore > 60 ? "positive" : averageScore < 40 ? "negative" : "neutral";
  const intentCounts = new Map();
  const tagCounts = new Map();

  for (const item of transcriptions) {
    if (item.intent) {
      intentCounts.set(item.intent, (intentCounts.get(item.intent) || 0) + 1);
    }
    for (const tag of Array.isArray(item.tags) ? item.tags : []) {
      if (tag) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }

  let topIntent = null;
  let intentCount = 0;
  for (const [intent, count] of intentCounts) {
    if (count > intentCount) {
      topIntent = intent;
      intentCount = count;
    }
  }

  return {
    topIntent,
    intentCount,
    topTags: [...tagCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([tag]) => tag),
    currentSentiment,
    currentScore,
    averageSentiment,
    averageScore,
  };
}

export async function persistAgentAssistTranscriptionsInTransaction(
  client,
  { workItemId, transcriptions },
) {
  // Serialize browser fallback saves and live server-side final turns even if
  // a workflow session has not been created yet. Without this lock, two first
  // utterances could race on the single acd_transcripts source_event_id and the
  // last upsert would replace rather than merge the other turn.
  await client.query(
    "SELECT id FROM acd_work_items WHERE id = $1 FOR UPDATE",
    [workItemId],
  );
  const workflowSession = (
    await client.query(
      `SELECT id, transcriptions
         FROM aa_workflow_sessions
        WHERE work_item_id = $1
        ORDER BY started_at DESC
        LIMIT 1
        FOR UPDATE`,
      [workItemId],
    )
  ).rows[0];
  const sourceEventId = `agent-assist-history:${workItemId}`;
  const transcriptArtifact = (
    await client.query(
      `SELECT id, segments
         FROM acd_transcripts
        WHERE source_event_id = $1
        LIMIT 1
        FOR UPDATE`,
      [sourceEventId],
    )
  ).rows[0];
  const durableTranscriptions = mergeAgentAssistTranscriptions(
    transcriptArtifact?.segments,
    workflowSession?.transcriptions,
  );
  const mergedTranscriptions = mergeAgentAssistTranscriptions(
    durableTranscriptions,
    transcriptions,
  );
  const summary = calculateAgentAssistTranscriptSummary(mergedTranscriptions);

  if (workflowSession) {
    await client.query(
      `UPDATE aa_workflow_sessions
          SET transcriptions = $2::jsonb, updated_at = now()
        WHERE id = $1`,
      [workflowSession.id, JSON.stringify(mergedTranscriptions)],
    );
  }

  const transcriptText = mergedTranscriptions
    .map((entry) => String(entry?.transcript || entry?.text || "").trim())
    .filter(Boolean)
    .join("\n");
  await client.query(
    `INSERT INTO acd_transcripts
       (id, work_item_id, provider, source_event_id, source, text,
        segments, summary, provider_metadata)
     VALUES ($1, $2, 'contact-center', $3, 'agent_assist', $4,
             $5::jsonb, $6, $7::jsonb)
     ON CONFLICT (source_event_id) DO UPDATE SET
       text = EXCLUDED.text,
       segments = EXCLUDED.segments,
       summary = EXCLUDED.summary,
       provider_metadata = EXCLUDED.provider_metadata,
       updated_at = now()`,
    [
      randomUUID(),
      workItemId,
      sourceEventId,
      transcriptText,
      JSON.stringify(mergedTranscriptions),
      summary.topIntent || null,
      JSON.stringify({
        summary,
        workflow_session_id: workflowSession?.id || null,
      }),
    ],
  );

  return { mergedTranscriptions, summary, workflowSessionId: workflowSession?.id || null };
}

export async function persistAgentAssistTranscriptions(
  pool,
  { workItemId, transcriptions },
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await persistAgentAssistTranscriptionsInTransaction(client, {
      workItemId,
      transcriptions,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

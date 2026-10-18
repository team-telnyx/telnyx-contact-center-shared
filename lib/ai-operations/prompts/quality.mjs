import { listCriteria } from '../../quality/scoring.mjs';
export function buildSystemPrompt(aiPromptConfig) {
  const persona =
    aiPromptConfig?.persona ||
    "You are a strict but fair contact center quality analyst. Score only based on evidence found in the transcript.";

  return `${persona}

You evaluate an interaction transcript against a quality scorecard. Rules:
- Score ONLY what is supported by the transcript. Never invent facts.
- For every criterion return: score (number), reasoning (1-3 sentences), evidence (short verbatim quote from the transcript, or empty string if none applies), confidence (0..1).
- Boolean criteria use score 1 (pass) or 0 (fail).
- Score criteria use integers from 0 to the criterion's maxScore.
- If the transcript gives no signal at all for a criterion, set "na": true with a short reasoning.
- Respond with VALID JSON ONLY, no markdown fences, matching the requested output schema exactly.`;
}

export function buildUserPrompt({ schema, transcriptText, context }) {
  const criteria = listCriteria(schema).map((item) => ({
    id: item.id,
    section: item.sectionTitle,
    label: item.label,
    description: item.description || "",
    type: item.type || "score",
    maxScore: item.maxScore,
    rubric: item.aiRubric || null,
  }));

  const contextLines = [];
  if (context?.agentName) contextLines.push(`Agent: ${context.agentName}`);
  if (context?.queueName) contextLines.push(`Queue: ${context.queueName}`);
  if (context?.channel) contextLines.push(`Channel: ${context.channel}`);
  if (context?.direction) contextLines.push(`Direction: ${context.direction}`);

  return `Evaluate this contact center interaction.

${contextLines.length ? `INTERACTION CONTEXT:\n${contextLines.join("\n")}\n` : ""}SCORECARD CRITERIA (JSON):
${JSON.stringify(criteria, null, 2)}

TRANSCRIPT:
"""
${transcriptText}
"""

Return JSON with this exact shape:
{
  "answers": [
    { "criterionId": "<id>", "score": <number>, "na": <boolean>, "reasoning": "<string>", "evidence": "<string>", "confidence": <0..1> }
  ],
  "summary": "<2-4 sentence overall quality summary>",
  "strengths": ["<string>"],
  "coachingTips": ["<string>"],
  "risks": ["<string>"]
}`;
}

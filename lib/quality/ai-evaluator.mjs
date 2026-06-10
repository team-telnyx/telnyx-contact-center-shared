/**
 * Quality Management AI evaluator.
 *
 * Takes a call transcript plus a quality form schema and asks the Telnyx AI
 * chat completions API to fill the scorecard. Every criterion must come back
 * with a score, reasoning, transcript evidence, and a confidence value so the
 * supervisor can audit the draft before finalizing it.
 */

import { buildTelnyxV2Url } from "@/lib/telnyx";
import { createDiagnosticLogger } from "@/lib/diagnostic-logger.mjs";
import { listCriteria, computeEvaluationScore } from "@/lib/quality/scoring.mjs";

const qualityLogger = createDiagnosticLogger("contact-center.quality");

const DEFAULT_EVALUATION_MODEL = "openai/gpt-4o";

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

function buildSystemPrompt(aiPromptConfig) {
  const persona =
    aiPromptConfig?.persona ||
    "You are a strict but fair contact center quality analyst. Score only based on evidence found in the transcript.";

  return `${persona}

You evaluate a call transcript against a quality scorecard. Rules:
- Score ONLY what is supported by the transcript. Never invent facts.
- For every criterion return: score (number), reasoning (1-3 sentences), evidence (short verbatim quote from the transcript, or empty string if none applies), confidence (0..1).
- Boolean criteria use score 1 (pass) or 0 (fail).
- Score criteria use integers from 0 to the criterion's maxScore.
- If the transcript gives no signal at all for a criterion, set "na": true with a short reasoning.
- Respond with VALID JSON ONLY, no markdown fences, matching the requested output schema exactly.`;
}

function buildUserPrompt({ schema, transcriptText, context }) {
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
  if (context?.direction) contextLines.push(`Direction: ${context.direction}`);

  return `Evaluate this contact center call.

${contextLines.length ? `CALL CONTEXT:\n${contextLines.join("\n")}\n` : ""}SCORECARD CRITERIA (JSON):
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

function parseJsonResponse(content) {
  if (!content) return null;
  let text = String(content).trim();
  // Strip markdown fences if the model added them anyway.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeAnswers(schema, rawAnswers) {
  const criteria = listCriteria(schema);
  const byId = new Map(criteria.map((item) => [item.id, item]));
  const answers = {};

  for (const raw of Array.isArray(rawAnswers) ? rawAnswers : []) {
    const criterion = byId.get(raw?.criterionId);
    if (!criterion) continue;
    if (raw?.na === true) {
      answers[criterion.id] = {
        na: true,
        score: null,
        reasoning: String(raw.reasoning || ""),
        evidence: "",
        confidence: null,
        source: "ai",
      };
      continue;
    }
    const maxScore = Number(criterion.maxScore || 0);
    const score = Math.max(0, Math.min(maxScore, Math.round(Number(raw?.score ?? 0))));
    const confidence = Number(raw?.confidence);
    answers[criterion.id] = {
      na: false,
      score,
      reasoning: String(raw?.reasoning || ""),
      evidence: String(raw?.evidence || ""),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
      source: "ai",
    };
  }

  return answers;
}

/**
 * Run the AI evaluation for a transcript against a quality form.
 * Returns { answers, score, summary, strengths, coachingTips, risks, model }.
 */
export async function evaluateTranscriptWithAi({
  schema,
  scoringConfig,
  aiPromptConfig,
  transcriptText,
  context,
  model,
}) {
  if (!transcriptText || !transcriptText.trim()) {
    throw new Error("Transcript text is required for AI evaluation");
  }

  const evaluationModel = model || aiPromptConfig?.model || DEFAULT_EVALUATION_MODEL;
  const apiKey = getApiKey();
  const url = buildTelnyxV2Url("/ai/chat/completions");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: evaluationModel,
      temperature: 0.2,
      max_tokens: 4000,
      messages: [
        { role: "system", content: buildSystemPrompt(aiPromptConfig) },
        { role: "user", content: buildUserPrompt({ schema, transcriptText, context }) },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    qualityLogger.error("quality_ai_evaluation_request_failed", {
      status: response.status,
    });
    throw new Error(
      errorBody?.detail || errorBody?.message || `AI evaluation request failed (${response.status})`,
    );
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  const parsed = parseJsonResponse(content);
  if (!parsed || !Array.isArray(parsed.answers)) {
    qualityLogger.error("quality_ai_evaluation_parse_failed");
    throw new Error("AI evaluation returned an unparseable response");
  }

  const answers = normalizeAnswers(schema, parsed.answers);
  const score = computeEvaluationScore(schema, answers, scoringConfig);

  return {
    answers,
    score,
    summary: String(parsed.summary || ""),
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
    coachingTips: Array.isArray(parsed.coachingTips) ? parsed.coachingTips.map(String) : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
    model: evaluationModel,
  };
}

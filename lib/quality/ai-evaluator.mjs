import { buildSystemPrompt, buildUserPrompt } from '../ai-operations/prompts/quality.mjs';
import { prepareAiOperation, operationModel } from '@/lib/ai-operations/runtime.mjs';
/**
 * Quality Management AI evaluator.
 *
 * Takes an interaction transcript plus a quality form schema and asks the Telnyx AI
 * chat completions API to fill the scorecard. Every criterion must come back
 * with a score, reasoning, transcript evidence, and a confidence value so the
 * supervisor can audit the draft before finalizing it.
 */

import { buildTelnyxV2Url } from "@/lib/telnyx";
import { createDiagnosticLogger } from "@/lib/diagnostic-logger.mjs";
import { listCriteria, computeEvaluationScore } from "@/lib/quality/scoring.mjs";

import { resolveEvaluationModel } from "./models.mjs";
import { qualityProviderError } from "./provider-error.mjs";

const qualityLogger = createDiagnosticLogger("contact-center.quality");

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
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
    if (typeof raw?.score !== "number" || !Number.isFinite(raw.score)) continue;
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

  const evaluationModel = await operationModel("quality-evaluation", resolveEvaluationModel(model, aiPromptConfig));
  const apiKey = getApiKey();
  const url = buildTelnyxV2Url("/ai/chat/completions");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(180_000),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(await prepareAiOperation('quality-evaluation', {
      model: evaluationModel,
      temperature: 0.2,
      max_tokens: 4000,
      messages: [
        { role: "system", content: buildSystemPrompt(aiPromptConfig) },
        { role: "user", content: buildUserPrompt({ schema, transcriptText, context }) },
      ],
    }, {preferredModel: evaluationModel})),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    qualityLogger.error("quality_ai_evaluation_request_failed", {
      status: response.status, model: evaluationModel, code: errorBody?.errors?.[0]?.code,
    });
    throw qualityProviderError(errorBody, response.status, "AI evaluation", apiKey);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  const parsed = parseJsonResponse(content);
  if (!parsed || !Array.isArray(parsed.answers)) {
    qualityLogger.error("quality_ai_evaluation_parse_failed");
    throw new Error("AI evaluation returned an unparseable response");
  }

  const answers = normalizeAnswers(schema, parsed.answers);
  const criteria = listCriteria(schema);
  if (!criteria.length || criteria.some(item => !answers[item.id]
    || (!answers[item.id].na && !Number.isFinite(answers[item.id].score)))) {
    throw new Error("AI evaluation did not return valid scores for every criterion. The draft was not replaced.");
  }
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

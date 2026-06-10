/**
 * Quality Management scoring helpers.
 *
 * A quality form schema is { sections: [{ id, title, criteria: [criterion] }] }
 * where criterion = {
 *   id, label, description, type: "score" | "boolean",
 *   maxScore, weight, criticalFail, aiRubric
 * }.
 *
 * Answers shape: { [criterionId]: { score, comment?, evidence?, confidence?, na? } }
 */

export function listCriteria(schema) {
  const items = [];
  for (const section of schema?.sections || []) {
    for (const criterionItem of section.criteria || []) {
      items.push({ ...criterionItem, sectionId: section.id, sectionTitle: section.title });
    }
  }
  return items;
}

export function computeEvaluationScore(schema, answers, scoringConfig = {}) {
  const criteria = listCriteria(schema);
  let total = 0;
  let max = 0;
  let answeredCount = 0;
  let criticalFailed = false;

  for (const criterionItem of criteria) {
    const weight = Number(criterionItem.weight || 1);
    const maxScore = Number(criterionItem.maxScore || 0) * weight;
    const answer = answers?.[criterionItem.id];

    if (answer?.na === true) continue;

    max += maxScore;
    if (answer == null || answer.score == null) continue;

    answeredCount += 1;
    const rawScore = Math.max(0, Math.min(Number(criterionItem.maxScore || 0), Number(answer.score)));
    total += rawScore * weight;

    if (criterionItem.criticalFail && rawScore <= 0) {
      criticalFailed = true;
    }
  }

  if (criticalFailed && scoringConfig?.criticalFailZeroesScore) {
    total = 0;
  }

  const percent = max > 0 ? Math.round((total / max) * 10000) / 100 : 0;

  return {
    scoreTotal: Math.round(total * 100) / 100,
    scoreMax: Math.round(max * 100) / 100,
    scorePercent: percent,
    answeredCount,
    criteriaCount: criteria.length,
    criticalFailed,
    passed:
      typeof scoringConfig?.passThresholdPercent === "number"
        ? percent >= scoringConfig.passThresholdPercent && !criticalFailed
        : null,
  };
}

#!/usr/bin/env node

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const input = await new Promise((resolve) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => resolve(value));
});

const encoded = input.match(/BENCHMARK_GZIP_BASE64=([A-Za-z0-9+/=]+)/)?.[1];
if (!encoded) throw new Error("BENCHMARK_GZIP_BASE64 payload was not found on stdin");

const rawJson = gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
const benchmark = JSON.parse(rawJson);
const artifactSha256 = createHash("sha256").update(rawJson).digest("hex");

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function pearson(left, right) {
  const pairs = left.map((value, index) => [value, right[index]])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (pairs.length < 2) return null;
  const leftMean = mean(pairs.map(([value]) => value));
  const rightMean = mean(pairs.map(([, value]) => value));
  let numerator = 0;
  let leftDenominator = 0;
  let rightDenominator = 0;
  for (const [a, b] of pairs) {
    const da = a - leftMean;
    const db = b - rightMean;
    numerator += da * db;
    leftDenominator += da ** 2;
    rightDenominator += db ** 2;
  }
  const denominator = Math.sqrt(leftDenominator * rightDenominator);
  return denominator ? numerator / denominator : null;
}

function percent(count, total) {
  return total ? round((count / total) * 100, 1) : null;
}

function summarizeDurations(values) {
  return {
    mean: round(mean(values)),
    p50: round(quantile(values, 0.5)),
    p90: round(quantile(values, 0.9)),
    p95: round(quantile(values, 0.95)),
    max: round(Math.max(...values.filter(Number.isFinite))),
  };
}

function normalizeDlr(record) {
  return record.attributes ? { id: record.id, ...record.attributes } : record;
}

function expectedValuesForRow(fixture, row) {
  const values = { ...(fixture?.expected_values || {}) };
  const firstNames = ["Jordan", "Morgan", "Taylor", "Parker", "Bailey", "Sydney", "Reagan", "Leslie", "Hayden", "Dakota"];
  const lastNames = ["Taylor", "Parker", "Miller", "Wilson", "Thomas", "Carter", "Turner", "Walker", "Harris", "Foster"];
  const index = Math.max(0, Number(row.repetition || 1) - 1) % firstNames.length;
  if (fixture?.id === "B-intent-and-first-name") {
    const firstNameItem = fixture.expected_item_ids?.[1];
    if (firstNameItem) values[firstNameItem] = firstNames[index];
  }
  if (fixture?.id === "C-caller-last-name") {
    const lastNameItem = fixture.expected_item_ids?.[0];
    if (lastNameItem) values[lastNameItem] = lastNames[index];
  }
  return values;
}

function normalizeExpected(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function recomputeSemanticExact(row) {
  const fixture = benchmark.fixtures.find((item) => item.id === row.fixture);
  if (!fixture || !row.schema_valid) return false;
  const expectedIds = new Set(fixture.expected_item_ids || []);
  const returnedIds = new Set(row.returned_item_ids || []);
  if (expectedIds.size !== returnedIds.size || [...expectedIds].some((id) => !returnedIds.has(id))) return false;
  const expectedValues = expectedValuesForRow(fixture, row);
  return Object.entries(expectedValues).every(([id, expected]) => {
    const actual = normalizeExpected(row.returned_values?.[id]);
    const wanted = normalizeExpected(expected);
    if (id === "e92f32b3-678c-4044-acb0-79e27c620e8b") {
      return actual.includes("transport") || actual.includes("flight");
    }
    return actual === wanted || actual.includes(wanted) || wanted.includes(actual);
  });
}

const dlrs = (benchmark.inference_dlrs || []).map(normalizeDlr);
const unusedDlrIds = new Set(dlrs.map((record) => record.id));
const correlated = benchmark.results
  .slice()
  .sort((a, b) => Date.parse(a.end_utc) - Date.parse(b.end_utc))
  .map((result) => {
    const resultEnd = Date.parse(result.end_utc);
    const candidates = dlrs
      .filter((record) => unusedDlrIds.has(record.id) && record.model === result.model)
      .map((record) => {
        const promptMatches = number(record.user_prompt_tokens) === number(result.prompt_tokens);
        const completionMatches = number(record.completion_tokens) === number(result.completion_tokens);
        const timeDeltaMs = Math.abs(Date.parse(record.created_at) - resultEnd);
        const score = timeDeltaMs + (promptMatches ? 0 : 60_000) + (completionMatches ? 0 : 60_000);
        return { record, promptMatches, completionMatches, timeDeltaMs, score };
      })
      .sort((a, b) => a.score - b.score);
    const best = candidates[0];
    const defensible = best && best.promptMatches && best.completionMatches && best.timeDeltaMs <= 5_000;
    if (defensible) unusedDlrIds.delete(best.record.id);
    const providerSeconds = defensible ? number(best.record.inference_time) : null;
    const clientSeconds = number(result.client_total_ms) / 1000;
    const correlatedRow = {
      ...result,
      client_seconds: clientSeconds,
      dlr_match: defensible,
      dlr_id: defensible ? best.record.id : null,
      dlr_time_delta_ms: defensible ? best.timeDeltaMs : null,
      provider_seconds: providerSeconds,
      non_provider_seconds: Number.isFinite(providerSeconds) ? clientSeconds - providerSeconds : null,
      dlr_prompt_tokens: defensible ? number(best.record.user_prompt_tokens) : null,
      dlr_cached_tokens: defensible ? number(best.record.cached_user_prompt_tokens) : null,
      dlr_completion_tokens: defensible ? number(best.record.completion_tokens) : null,
      dlr_cost_usd: defensible ? number(best.record.cost) : null,
      service_tier: defensible ? best.record.service_tier : null,
      hardware: defensible ? best.record.hardware : null,
    };
    correlatedRow.semantic_exact = recomputeSemanticExact(correlatedRow);
    return correlatedRow;
  })
  .sort((a, b) => a.sequence - b.sequence);

const measured = correlated.filter((result) => result.phase === "measured");
const warmups = correlated.filter((result) => result.phase === "warmup");

function groupStats(rows) {
  const client = rows.map((row) => row.client_seconds).filter(Number.isFinite);
  const provider = rows.map((row) => row.provider_seconds).filter(Number.isFinite);
  const nonProvider = rows.map((row) => row.non_provider_seconds).filter(Number.isFinite);
  const completions = rows.map((row) => number(row.completion_tokens)).filter(Number.isFinite);
  const prompts = rows.map((row) => number(row.prompt_tokens)).filter(Number.isFinite);
  const cached = rows.map((row) => number(row.dlr_cached_tokens)).filter(Number.isFinite);
  const totalCost = rows.map((row) => row.dlr_cost_usd).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
  const expectedItems = rows.reduce((sum, row) => {
    const fixture = benchmark.fixtures.find((item) => item.id === row.fixture);
    return sum + (fixture?.expected_item_ids?.length || 0);
  }, 0);
  const truePositiveItems = rows.reduce((sum, row) => {
    const fixture = benchmark.fixtures.find((item) => item.id === row.fixture);
    const expected = new Set(fixture?.expected_item_ids || []);
    return sum + (row.returned_item_ids || []).filter((id) => expected.has(id)).length;
  }, 0);
  const returnedItems = rows.reduce((sum, row) => sum + (row.returned_item_ids || []).length, 0);
  const precision = returnedItems ? truePositiveItems / returnedItems : null;
  const recall = expectedItems ? truePositiveItems / expectedItems : null;
  const f1 = precision != null && recall != null && precision + recall
    ? (2 * precision * recall) / (precision + recall)
    : null;
  return {
    n: rows.length,
    http_success_pct: percent(rows.filter((row) => row.http_ok).length, rows.length),
    json_valid_pct: percent(rows.filter((row) => row.analysis_json_valid).length, rows.length),
    schema_valid_pct: percent(rows.filter((row) => row.schema_valid).length, rows.length),
    semantic_exact_pct: percent(rows.filter((row) => row.semantic_exact).length, rows.length),
    item_precision_pct: round(precision * 100, 1),
    item_recall_pct: round(recall * 100, 1),
    item_f1_pct: round(f1 * 100, 1),
    timeouts: rows.filter((row) => row.timed_out).length,
    client_seconds: summarizeDurations(client),
    provider_seconds: summarizeDurations(provider),
    non_provider_seconds: summarizeDurations(nonProvider),
    completion_tokens: {
      p50: round(quantile(completions, 0.5), 1),
      p95: round(quantile(completions, 0.95), 1),
      max: completions.length ? Math.max(...completions) : null,
    },
    prompt_tokens: {
      p50: round(quantile(prompts, 0.5), 1),
      min: prompts.length ? Math.min(...prompts) : null,
      max: prompts.length ? Math.max(...prompts) : null,
    },
    cached_prompt_pct: prompts.length && cached.length
      ? round((cached.reduce((sum, value) => sum + value, 0) / prompts.reduce((sum, value) => sum + value, 0)) * 100, 1)
      : null,
    over_3s_pct: percent(client.filter((value) => value > 3).length, client.length),
    over_8s_pct: percent(client.filter((value) => value > 8).length, client.length),
    over_10s_pct: percent(client.filter((value) => value > 10).length, client.length),
    over_20s_pct: percent(client.filter((value) => value > 20).length, client.length),
    reasoning_channel_pct: percent(rows.filter((row) => row.response_channel === "reasoning").length, rows.length),
    dlr_matches: rows.filter((row) => row.dlr_match).length,
    cost_usd: round(totalCost, 6),
    hardware: [...new Set(rows.map((row) => row.hardware).filter(Boolean))],
    service_tiers: [...new Set(rows.map((row) => row.service_tier).filter(Boolean))],
    completion_provider_pearson: round(pearson(completions, rows.map((row) => row.provider_seconds)), 4),
    prompt_provider_pearson: round(pearson(prompts, rows.map((row) => row.provider_seconds)), 4),
  };
}

const modelStats = Object.fromEntries(benchmark.models.map((model) => [
  model,
  groupStats(measured.filter((row) => row.model === model)),
]));

const fixtureStats = Object.fromEntries(benchmark.fixtures.map((fixture) => [
  fixture.id,
  Object.fromEntries(benchmark.models.map((model) => [
    model,
    groupStats(measured.filter((row) => row.fixture === fixture.id && row.model === model)),
  ])),
]));

const baselineModel = "openai/gpt-5.4";
const pairedRatios = {};
for (const model of benchmark.models.filter((item) => item !== baselineModel)) {
  const clientRatios = [];
  const providerRatios = [];
  for (const row of measured.filter((item) => item.model === model)) {
    const baseline = measured.find((item) =>
      item.model === baselineModel &&
      item.fixture === row.fixture &&
      item.repetition === row.repetition
    );
    if (!baseline) continue;
    clientRatios.push(row.client_seconds / baseline.client_seconds);
    if (Number.isFinite(row.provider_seconds) && Number.isFinite(baseline.provider_seconds)) {
      providerRatios.push(row.provider_seconds / baseline.provider_seconds);
    }
  }
  pairedRatios[model] = {
    pairs: clientRatios.length,
    client_median_ratio: round(quantile(clientRatios, 0.5), 2),
    client_p95_ratio: round(quantile(clientRatios, 0.95), 2),
    provider_median_ratio: round(quantile(providerRatios, 0.5), 2),
    provider_p95_ratio: round(quantile(providerRatios, 0.95), 2),
  };
}

const rawObservations = Object.fromEntries(benchmark.fixtures.map((fixture) => [
  fixture.id,
  Object.fromEntries(benchmark.models.map((model) => {
    const rows = measured
      .filter((row) => row.fixture === fixture.id && row.model === model)
      .sort((a, b) => a.repetition - b.repetition);
    return [model, rows.map((row) => ({
      repetition: row.repetition,
      client_seconds: round(row.client_seconds),
      provider_seconds: round(row.provider_seconds),
      completion_tokens: row.completion_tokens,
      semantic_exact: row.semantic_exact,
    }))];
  })),
]));

const output = {
  artifact_sha256: artifactSha256,
  started_at: benchmark.started_at,
  completed_at: benchmark.completed_at,
  duration_minutes: round((Date.parse(benchmark.completed_at) - Date.parse(benchmark.started_at)) / 60_000, 2),
  endpoint: benchmark.endpoint,
  workflow_id: benchmark.workflow_id,
  settings: benchmark.settings,
  fixtures: benchmark.fixtures,
  total_calls: correlated.length,
  measured_calls: measured.length,
  warmup_calls: warmups.length,
  detail_records: dlrs.length,
  correlated_detail_records: correlated.filter((row) => row.dlr_match).length,
  unmatched_result_sequences: correlated.filter((row) => !row.dlr_match).map((row) => row.sequence),
  unused_detail_record_ids: [...unusedDlrIds],
  maximum_dlr_time_delta_ms: round(Math.max(...correlated.map((row) => row.dlr_time_delta_ms || 0)), 1),
  model_stats: modelStats,
  fixture_stats: fixtureStats,
  paired_ratios_vs_gpt_5_4: pairedRatios,
  warmups: warmups.map((row) => ({
    model: row.model,
    fixture: row.fixture,
    client_seconds: round(row.client_seconds),
    provider_seconds: round(row.provider_seconds),
    completion_tokens: row.completion_tokens,
    semantic_exact: row.semantic_exact,
  })),
  raw_observations: rawObservations,
};

console.log(JSON.stringify(output, null, 2));

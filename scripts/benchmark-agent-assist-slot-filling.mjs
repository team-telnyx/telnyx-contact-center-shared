#!/usr/bin/env node

/**
 * Controlled, PHI-free benchmark of the production Agent Assist slot prompt.
 *
 * This script is intended to run inside the deployed cc-the reference workflow application
 * container. It imports the deployed prompt builder, reads only static workflow
 * definitions, and calls the same legacy Telnyx chat-completion endpoint as the
 * live slot analyzer. It does not create/update workflow sessions or item state.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { getPostgresPool } from "../lib/postgres.mjs";
import {
  buildWorkflowAnalysisSystemPrompt,
  buildWorkflowAnalysisUserPrompt,
} from "../lib/agent-assist/workflow-prompts.js";

const API_BASE = "https://api.telnyx.com/v2";
const WORKFLOW_ID = "00000000-0000-4000-8000-000000000001";
const OUTPUT_PATH = process.env.BENCHMARK_OUTPUT || "/tmp/agent-assist-slot-benchmark-results.json";
const REPEATS = Math.max(1, Number.parseInt(process.env.BENCHMARK_REPEATS || "10", 10));
const TIMEOUT_MS = Math.max(1_000, Number.parseInt(process.env.BENCHMARK_TIMEOUT_MS || "180000", 10));
const PAUSE_MS = Math.max(0, Number.parseInt(process.env.BENCHMARK_PAUSE_MS || "1000", 10));
const DLR_POLL_MS = Math.max(1_000, Number.parseInt(process.env.BENCHMARK_DLR_POLL_MS || "30000", 10));
const DLR_MAX_POLLS = Math.max(1, Number.parseInt(process.env.BENCHMARK_DLR_MAX_POLLS || "4", 10));
const STDOUT_GZIP = process.env.BENCHMARK_STDOUT_GZIP === "true";
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

const DEFAULT_MODELS = [
  "openai/gpt-5.4",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol",
  "moonshotai/Kimi-K3",
];
const MODELS = (process.env.BENCHMARK_MODELS || DEFAULT_MODELS.join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const ENABLE_THINKING = process.env.BENCHMARK_ENABLE_THINKING === "true"
  ? true
  : process.env.BENCHMARK_ENABLE_THINKING === "false"
    ? false
    : undefined;
const FIXTURE_IDS = (process.env.BENCHMARK_FIXTURES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const IDS = {
  askAssist: "e26e5d1c-2256-45fa-a17f-74d723752a32",
  intent: "e92f32b3-678c-4044-acb0-79e27c620e8b",
  confirmIntent: "7bd48126-9a59-4ee4-b588-3cb2ebcd2832",
  callerFirst: "b898033c-6248-4ad8-aa2b-4ced41e082cc",
  callerLast: "a5721769-61e1-4049-825c-f1996856a426",
  callerFacility: "e1e61e13-65cd-4f61-bf93-85e1f4db7097",
  callback: "8a20af05-be7b-49d3-99e9-f9f6bf51502a",
  pickupFacility: "8ceba05f-41bc-4660-8ad5-5cf41abd1e3e",
  pickupAddress: "25053dd2-e606-415e-9418-dc9c493708d0",
  pickupDepartment: "8f4933f3-1129-4df3-bfa8-31611351ae8e",
  pickupRoom: "e22eb895-4c08-47eb-bfc3-4888953178ee",
  pickupBed: "efd17ca5-8727-4210-a118-b3f2e80b6ff6",
  sendingPhysician: "543ff1b4-aec6-4987-9a42-9faa6a1882cb",
  readback: "21be5340-1b14-41e4-80d9-be3e49ddfedd",
};

const FIXTURE_DEFS = [
  {
    id: "A-agent-opening",
    itemIds: [IDS.askAssist, IDS.intent, IDS.confirmIntent],
    slotsFilled: {},
    currentTargetId: IDS.intent,
    currentStageName: "Intent Identification",
    speaker: "outbound",
    transcript: "Thank you for calling Acme Air Medical. How can I help you today?",
    recentContext: [],
    expectedItemIds: [IDS.askAssist],
    expectedValues: {},
  },
  {
    id: "B-intent-and-first-name",
    itemIds: [
      IDS.intent,
      IDS.confirmIntent,
      IDS.callerFirst,
      IDS.callerLast,
      IDS.callerFacility,
      IDS.callback,
      IDS.readback,
    ],
    slotsFilled: {},
    currentTargetId: IDS.intent,
    currentStageName: "Intent Identification",
    speaker: "inbound",
    transcript: "I need air transport urgently. My first name is Jordan; I can provide all details now.",
    recentContext: [
      { speaker: "outbound", text: "Thank you for calling Acme Air Medical. How can I help you today?" },
    ],
    expectedItemIds: [IDS.intent, IDS.callerFirst],
    expectedValues: {
      [IDS.intent]: "transport",
      [IDS.callerFirst]: "Jordan",
    },
  },
  {
    id: "C-caller-last-name",
    itemIds: [
      IDS.confirmIntent,
      IDS.callerLast,
      IDS.callerFacility,
      IDS.callback,
      IDS.pickupFacility,
      IDS.pickupAddress,
      IDS.pickupDepartment,
      IDS.pickupRoom,
      IDS.pickupBed,
      IDS.sendingPhysician,
      IDS.readback,
    ],
    slotsFilled: { intent: "urgent air transport", caller_first_name: "Jordan" },
    currentTargetId: IDS.callerLast,
    currentStageName: "Caller Identification",
    speaker: "inbound",
    transcript: "The last name is Taylor, T-A-Y-L-O-R.",
    recentContext: [
      { speaker: "outbound", text: "Thank you for calling Acme Air Medical. How can I help you today?" },
      { speaker: "inbound", text: "I need air transport urgently. My first name is Jordan; I can provide all details now." },
    ],
    expectedItemIds: [IDS.callerLast],
    expectedValues: { [IDS.callerLast]: "Taylor" },
  },
];

const FIRST_NAMES = ["Jordan", "Morgan", "Taylor", "Parker", "Bailey", "Sydney", "Reagan", "Leslie", "Hayden", "Dakota"];
const LAST_NAMES = ["Taylor", "Parker", "Miller", "Wilson", "Thomas", "Carter", "Turner", "Walker", "Harris", "Foster"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeValue(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stripFences(value) {
  return String(value || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

function spelled(value) {
  return [...value.toUpperCase()].join("-");
}

function usageFromResponse(data) {
  const usage = data?.usage || {};
  return {
    prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    cached_tokens:
      usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.cached_tokens ??
      null,
    reasoning_tokens:
      usage.completion_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      usage.reasoning_tokens ??
      null,
  };
}

function validateAnalysis(parsed, fixture) {
  const pending = new Set(fixture.itemIds);
  const expected = new Set(fixture.expectedItemIds);
  const items = Array.isArray(parsed?.completed_items) ? parsed.completed_items : null;
  if (!items) {
    return { schema_valid: false, semantic_exact: false, precision: 0, recall: 0, hallucinated_item_ids: [] };
  }

  let schemaValid = true;
  const returnedIds = new Set();
  const hallucinated = [];
  const valueChecks = [];
  const returnedValues = {};

  for (const item of items) {
    const id = item?.item_id;
    if (!id || !pending.has(id)) {
      schemaValid = false;
      if (id) hallucinated.push(id);
      continue;
    }
    returnedIds.add(id);
    if (item.extracted_value !== undefined) returnedValues[id] = item.extracted_value;
    if (typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1) schemaValid = false;
    if (item.alternatives !== undefined && !Array.isArray(item.alternatives)) schemaValid = false;
    if (fixture.expectedValues[id] !== undefined) {
      const actual = normalizeValue(item.extracted_value);
      const wanted = normalizeValue(fixture.expectedValues[id]);
      valueChecks.push(actual === wanted || actual.includes(wanted) || wanted.includes(actual));
    }
  }

  const truePositive = [...returnedIds].filter((id) => expected.has(id)).length;
  const precision = returnedIds.size === 0 ? (expected.size === 0 ? 1 : 0) : truePositive / returnedIds.size;
  const recall = expected.size === 0 ? 1 : truePositive / expected.size;
  const semanticExact =
    schemaValid &&
    returnedIds.size === expected.size &&
    [...expected].every((id) => returnedIds.has(id)) &&
    valueChecks.every(Boolean);

  return {
    schema_valid: schemaValid,
    semantic_exact: semanticExact,
    precision,
    recall,
    hallucinated_item_ids: hallucinated,
    returned_item_ids: [...returnedIds],
    returned_values: returnedValues,
  };
}

async function loadWorkflowItems() {
  const pool = getPostgresPool();
  if (!pool) throw new Error("PostgreSQL is not configured");
  try {
    const { rows } = await pool.query(
      `SELECT i.id AS item_id, i.type, i.label, i.description, i.prompt_hint,
              i.hints, i.slot_name, i.slot_type, i.slot_options,
              i.slot_validation, i.completion_trigger,
              s.name AS stage_name, s.order_index AS stage_order,
              i.order_index AS item_order
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON s.id = i.stage_id
        WHERE s.workflow_id = $1
        ORDER BY s.order_index, i.order_index`,
      [WORKFLOW_ID],
    );
    return rows;
  } finally {
    await pool.end();
  }
}

function buildFixtures(allItems) {
  const byId = new Map(allItems.map((item) => [item.item_id, item]));
  return FIXTURE_DEFS.map((definition) => {
    const pendingItems = definition.itemIds.map((id) => {
      const item = byId.get(id);
      if (!item) throw new Error(`Workflow item ${id} was not found`);
      return { ...item, current_status: "pending" };
    });
    const currentTargetItem = byId.get(definition.currentTargetId);
    const currentTarget = {
      itemId: currentTargetItem.item_id,
      label: currentTargetItem.label,
      slotName: currentTargetItem.slot_name,
      slotType: currentTargetItem.slot_type,
    };
    const slotCount = pendingItems.filter((item) => item.type === "slot").length;
    const maxTokens = Math.min(8000, 600 + pendingItems.length * 150 + slotCount * 100 + 400);
    return {
      ...definition,
      pendingItems,
      currentTarget,
      maxTokens,
    };
  });
}

function renderFixture(baseFixture, repetition = 1) {
  const variantIndex = Math.max(0, repetition - 1) % FIRST_NAMES.length;
  const firstName = FIRST_NAMES[variantIndex];
  const lastName = LAST_NAMES[variantIndex];
  let transcript = baseFixture.transcript;
  let recentContext = structuredClone(baseFixture.recentContext);
  let slotsFilled = structuredClone(baseFixture.slotsFilled);
  let expectedValues = structuredClone(baseFixture.expectedValues);

  if (baseFixture.id === "B-intent-and-first-name") {
    transcript = transcript.replaceAll("Jordan", firstName);
    expectedValues[IDS.callerFirst] = firstName;
  }
  if (baseFixture.id === "C-caller-last-name") {
    transcript = `The last name is ${lastName}, ${spelled(lastName)}.`;
    recentContext = recentContext.map((item) => ({ ...item, text: item.text.replaceAll("Jordan", firstName) }));
    slotsFilled.caller_first_name = firstName;
    expectedValues[IDS.callerLast] = lastName;
  }

  const systemPrompt = buildWorkflowAnalysisSystemPrompt({
      pendingItems: baseFixture.pendingItems,
      slotsFilled,
      includeIntent: false,
      includeSentiment: true,
      confidenceThreshold: 0.8,
      currentTarget: baseFixture.currentTarget,
      currentStageName: baseFixture.currentStageName,
      isReadBackStage: false,
      allowCorrections: false,
      correctionInProgress: false,
      bleedGuardSlot: null,
    });
    const userPrompt = buildWorkflowAnalysisUserPrompt({
      transcript,
      speaker: baseFixture.speaker,
      recentContext,
    });
    return {
      ...baseFixture,
      variant: variantIndex + 1,
      transcript,
      recentContext,
      slotsFilled,
      expectedValues,
      systemPrompt,
      userPrompt,
      prompt_sha256: createHash("sha256").update(`${systemPrompt}\n${userPrompt}`).digest("hex"),
      prompt_bytes: Buffer.byteLength(`${systemPrompt}\n${userPrompt}`),
    };
}

async function listModelMetadata() {
  const response = await fetch(`${API_BASE}/ai/openai/models`, {
    headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
  });
  if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}`);
  const data = await response.json();
  return (data.data || [])
    .filter((item) => MODELS.includes(item.id))
    .map((item) => ({
      id: item.id,
      owned_by: item.owned_by,
      context_length: item.context_length,
      max_completion_tokens: item.max_completion_tokens,
      service_tiers: item.service_tiers,
    }));
}

async function runOne({ fixture, model, phase, repetition, sequence }) {
  const renderedFixture = renderFixture(fixture, repetition || 1);
  const body = {
    messages: [
      { role: "system", content: renderedFixture.systemPrompt },
      { role: "user", content: renderedFixture.userPrompt },
    ],
    model,
    temperature: 0.3,
    max_tokens: renderedFixture.maxTokens,
    response_format: { type: "json_object" },
  };
  if (ENABLE_THINKING !== undefined) body.enable_thinking = ENABLE_THINKING;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("benchmark_timeout")), TIMEOUT_MS);
  const startUtc = new Date().toISOString();
  const started = performance.now();
  let headersAt = null;

  try {
    const response = await fetch(`${API_BASE}/ai/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    headersAt = performance.now();
    const text = await response.text();
    const ended = performance.now();
    const endUtc = new Date().toISOString();
    let envelope = null;
    let envelopeError = null;
    try {
      envelope = JSON.parse(text);
    } catch (error) {
      envelopeError = error.message;
    }

    const content = envelope?.choices?.[0]?.message?.content;
    const reasoning = envelope?.choices?.[0]?.message?.reasoning;
    const rawAnalysis = content || reasoning || "";
    let parsedAnalysis = null;
    let parseError = null;
    try {
      parsedAnalysis = JSON.parse(stripFences(rawAnalysis));
    } catch (error) {
      parseError = error.message;
    }
    const validation = parsedAnalysis
      ? validateAnalysis(parsedAnalysis, renderedFixture)
      : { schema_valid: false, semantic_exact: false, precision: 0, recall: 0, hallucinated_item_ids: [] };

    return {
      sequence,
      phase,
      repetition,
      fixture: fixture.id,
      variant: renderedFixture.variant,
      prompt_sha256: renderedFixture.prompt_sha256,
      prompt_bytes: renderedFixture.prompt_bytes,
      model,
      start_utc: startUtc,
      end_utc: endUtc,
      http_status: response.status,
      http_ok: response.ok,
      response_id: envelope?.id || response.headers.get("x-request-id") || null,
      response_model: envelope?.model || null,
      finish_reason: envelope?.choices?.[0]?.finish_reason || null,
      response_channel: content ? "content" : reasoning ? "reasoning" : null,
      response_bytes: Buffer.byteLength(text),
      headers_ms: Math.round((headersAt - started) * 1000) / 1000,
      body_ms: Math.round((ended - headersAt) * 1000) / 1000,
      client_total_ms: Math.round((ended - started) * 1000) / 1000,
      envelope_valid: Boolean(envelope),
      envelope_error: envelopeError,
      analysis_json_valid: Boolean(parsedAnalysis),
      analysis_parse_error: parseError,
      ...usageFromResponse(envelope),
      ...validation,
      error: response.ok ? null : envelope?.errors || envelope?.error || text.slice(0, 500),
    };
  } catch (error) {
    const ended = performance.now();
    return {
      sequence,
      phase,
      repetition,
      fixture: fixture.id,
      model,
      start_utc: startUtc,
      end_utc: new Date().toISOString(),
      http_status: null,
      http_ok: false,
      timed_out: controller.signal.aborted,
      client_total_ms: Math.round((ended - started) * 1000) / 1000,
      envelope_valid: false,
      analysis_json_valid: false,
      schema_valid: false,
      semantic_exact: false,
      precision: 0,
      recall: 0,
      error: error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchInferenceDlrs(startedAt, completedAt) {
  const endBoundary = new Date(new Date(completedAt).getTime() + 5 * 60_000).toISOString();
  const records = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(`${API_BASE}/detail_records`);
    url.searchParams.set("filter[record_type]", "inference");
    url.searchParams.set("filter[created_at][gte]", startedAt);
    url.searchParams.set("filter[created_at][lt]", endBoundary);
    url.searchParams.set("sort", "created_at");
    url.searchParams.set("page[size]", "50");
    url.searchParams.set("page[number]", String(page));
    const response = await fetch(url, { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } });
    if (!response.ok) throw new Error(`DLR search returned HTTP ${response.status}`);
    const data = await response.json();
    const pageRecords = Array.isArray(data.data) ? data.data : [];
    records.push(...pageRecords);
    if (pageRecords.length < 50) break;
  }
  return records
    .map((record) => record.attributes ? { id: record.id, ...record.attributes } : record)
    .filter((record) => MODELS.includes(record.model) && (!record.usecase || record.usecase === "chat-completions-api"))
    .map((record) => ({
      id: record.id,
      created_at: record.created_at,
      model: record.model,
      inference_time: record.inference_time,
      user_prompt_tokens: record.user_prompt_tokens,
      cached_user_prompt_tokens: record.cached_user_prompt_tokens,
      completion_tokens: record.completion_tokens,
      tokens: record.tokens,
      service_tier: record.service_tier,
      hardware: record.hardware,
      usecase: record.usecase,
      billable: record.billable,
      cost: record.cost,
      currency: record.currency,
    }));
}

function measuredSchedule(fixtures) {
  const schedule = [];
  const modelIndices = MODELS.map((_, index) => index);
  for (let repetition = 1; repetition <= REPEATS; repetition += 1) {
    for (let fixtureIndex = 0; fixtureIndex < fixtures.length; fixtureIndex += 1) {
      const offset = (repetition + fixtureIndex - 1) % modelIndices.length;
      const order = [...modelIndices.slice(offset), ...modelIndices.slice(0, offset)];
      for (const modelIndex of order) {
        schedule.push({ fixture: fixtures[fixtureIndex], model: MODELS[modelIndex], repetition });
      }
    }
  }
  return schedule;
}

async function main() {
  if (!TELNYX_API_KEY) throw new Error("TELNYX_API_KEY is required");

  const startedAt = new Date().toISOString();
  const allItems = await loadWorkflowItems();
  const allFixtures = buildFixtures(allItems);
  const fixtures = FIXTURE_IDS.length
    ? allFixtures.filter((fixture) => FIXTURE_IDS.includes(fixture.id))
    : allFixtures;
  const missingFixtures = FIXTURE_IDS.filter((id) => !fixtures.some((fixture) => fixture.id === id));
  if (missingFixtures.length) throw new Error(`Unknown fixtures: ${missingFixtures.join(", ")}`);
  const modelMetadata = await listModelMetadata();
  const missingModels = MODELS.filter((model) => !modelMetadata.some((item) => item.id === model));
  if (missingModels.length) throw new Error(`Unavailable models: ${missingModels.join(", ")}`);

  const results = [];
  let sequence = 0;

  for (let index = 0; index < MODELS.length; index += 1) {
    sequence += 1;
    results.push(await runOne({
      fixture: fixtures[index % fixtures.length],
      model: MODELS[index],
      phase: "warmup",
      repetition: 0,
      sequence,
    }));
    await sleep(PAUSE_MS);
  }

  for (const item of measuredSchedule(fixtures)) {
    sequence += 1;
    results.push(await runOne({ ...item, phase: "measured", sequence }));
    await sleep(PAUSE_MS);
  }

  const completedAt = new Date().toISOString();
  const expectedDlrs = results.filter((item) => item.http_ok).length;
  let inferenceDlrs = [];
  let stablePolls = 0;
  let priorCount = -1;
  for (let poll = 1; poll <= DLR_MAX_POLLS; poll += 1) {
    await sleep(DLR_POLL_MS);
    inferenceDlrs = await fetchInferenceDlrs(startedAt, completedAt);
    if (inferenceDlrs.length === priorCount) stablePolls += 1;
    else stablePolls = 0;
    priorCount = inferenceDlrs.length;
    if (inferenceDlrs.length >= expectedDlrs && stablePolls >= 1) break;
  }

  const output = {
    benchmark: "agent-assist-slot-filling-production-equivalent",
    started_at: startedAt,
    completed_at: completedAt,
    endpoint: `${API_BASE}/ai/chat/completions`,
    workflow_id: WORKFLOW_ID,
    models: MODELS,
    model_metadata: modelMetadata,
    settings: {
      repeats: REPEATS,
      timeout_ms: TIMEOUT_MS,
      pause_ms: PAUSE_MS,
      dlr_poll_ms: DLR_POLL_MS,
      dlr_max_polls: DLR_MAX_POLLS,
      temperature: 0.3,
      response_format: { type: "json_object" },
      include_intent: false,
      include_sentiment: true,
      confidence_threshold: 0.8,
      stream: "omitted (API default false)",
      service_tier: "omitted (API default)",
      enable_thinking: ENABLE_THINKING ?? "omitted (API default)",
    },
    fixtures: fixtures.map((baseFixture) => {
      const fixture = renderFixture(baseFixture, 1);
      return ({
      id: fixture.id,
      transcript: fixture.transcript,
      speaker: fixture.speaker,
      recent_context: fixture.recentContext,
      pending_item_ids: fixture.itemIds,
      pending_item_count: fixture.pendingItems.length,
      slot_count: fixture.pendingItems.filter((item) => item.type === "slot").length,
      slots_filled: fixture.slotsFilled,
      current_target: fixture.currentTarget,
      current_stage_name: fixture.currentStageName,
      max_tokens: fixture.maxTokens,
      prompt_sha256: fixture.prompt_sha256,
      prompt_bytes: fixture.prompt_bytes,
      expected_item_ids: fixture.expectedItemIds,
      expected_values: fixture.expectedValues,
      });
    }),
    results,
    inference_dlrs: inferenceDlrs,
  };

  if (STDOUT_GZIP) {
    const compactOutput = {
      ...output,
      results: output.results.map((item) => ({
        sequence: item.sequence,
        phase: item.phase,
        repetition: item.repetition,
        fixture: item.fixture,
        variant: item.variant,
        model: item.model,
        start_utc: item.start_utc,
        end_utc: item.end_utc,
        http_status: item.http_status,
        http_ok: item.http_ok,
        timed_out: item.timed_out,
        client_total_ms: item.client_total_ms,
        headers_ms: item.headers_ms,
        body_ms: item.body_ms,
        prompt_tokens: item.prompt_tokens,
        completion_tokens: item.completion_tokens,
        total_tokens: item.total_tokens,
        cached_tokens: item.cached_tokens,
        reasoning_tokens: item.reasoning_tokens,
        finish_reason: item.finish_reason,
        response_channel: item.response_channel,
        analysis_json_valid: item.analysis_json_valid,
        schema_valid: item.schema_valid,
        semantic_exact: item.semantic_exact,
        precision: item.precision,
        recall: item.recall,
        returned_item_ids: item.returned_item_ids,
        returned_values: item.returned_values,
        hallucinated_item_ids: item.hallucinated_item_ids,
        error: item.error,
      })),
    };
    const compressed = gzipSync(Buffer.from(JSON.stringify(compactOutput))).toString("base64");
    console.log(`BENCHMARK_GZIP_BASE64=${compressed}`);
  } else {
    await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      ok: true,
      output: OUTPUT_PATH,
      calls: results.length,
      measured_calls: results.filter((item) => item.phase === "measured").length,
      dlrs: inferenceDlrs.length,
      completed_at: output.completed_at,
    }));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});

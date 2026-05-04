#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applyFormOperations, validateFormOperations } from "../lib/forms/form-operations.js";
import { createDefaultForm, FORM_COMPONENT_TYPES, FORM_COMPONENT_REGISTRY, getFieldChildIds, normalizeFormDefinition, validateFormDefinition } from "../lib/forms/form-schema.js";
import { buildFormAiSystemPrompt, buildFormAiUserPayload, FORM_AI_OPERATION_SCHEMA } from "../lib/forms/form-ai-instructions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function loadDotEnv(file = path.join(repoRoot, ".env")) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

function extractJson(content = "") {
  if (typeof content !== "string") return content;
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(trimmed); } catch (err) {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw err;
  }
}

function baseForm() {
  return createDefaultForm({
    name: "AI evaluation blank form",
    slug: "ai-evaluation-blank-form",
    schema: { fields: [], pages: [{ id: "intake", title: "Intake", description: "", icon: "IconForms", fields: [] }], showNavigationButtons: true },
    layout: { order: [] },
    actions: [{ type: "submit", label: "Submit" }],
  });
}

const PROMPTS = [
  {
    id: "simple_contact_consent",
    level: "simple",
    prompt: "Create a single-page contact and consent form for a support agent. Include required customer name and email text inputs, a select for inquiry type with Billing/Technical/Sales options, and a required marketing consent checkbox. Use unique variableName values for all data fields."
  },
  {
    id: "medium_onboarding",
    level: "medium",
    prompt: "Build a polished three-page customer onboarding form. Page 1 should have a hero with inline image metadata, a card with an avatar and welcome rich text. Page 2 should collect company size with radio buttons, plan with select, enable_sms_updates with a switch, satisfaction target with a colored slider, and preferred onboarding datetime. Page 3 should show a context_value for caller.from_number, a badge, and a confirmation textarea. Add page icons and keep navigation buttons visible."
  },
  {
    id: "complex_workflow_layout",
    level: "complex",
    prompt: "Create a very complex multi-page escalation workflow form. Use nested layout: a 3-column grid with row/column spans, cards inside columns, a flex action row, accordion FAQ/guidance, stats, badge, image with imageScale 135, hero background image with fade/overlay, codeblock showing a JSON payload example, hidden interaction id, and many inputs: text, textarea, select, radio, checkbox group, switch, slider, datetime. Add a button wired to a data action using props.dataActionFlowId='flow_form_submit_escalation' and dataActionLabel='Escalation Form Submit'. Ensure every data-producing field has a unique variableName and children are referenced through container props, not duplicated as page roots."
  },
];

const DEFAULT_MODELS = [
  "moonshotai/Kimi-K2.6",
  "zai-org/GLM-5.1-FP8",
  "meta-llama/Llama-3.3-70B-Instruct",
  // GPT-5.5 was requested in the evaluation brief, but Telnyx model listing for this account exposed GPT-5/GPT-5.1/GPT-5.2 instead.
  "openai/gpt-5.2",
];

function argValue(name) {
  const item = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : null;
}

function fieldAudit(form) {
  const normalized = normalizeFormDefinition(form);
  const fields = normalized.schema?.fields || [];
  const typeSet = new Set(FORM_COMPONENT_TYPES);
  const dataFields = fields.filter((field) => FORM_COMPONENT_REGISTRY[field.type]?.data);
  const unsupportedTypes = fields.filter((field) => !typeSet.has(field.type)).map((field) => ({ id: field.id, type: field.type }));
  const missingVariableNames = dataFields.filter((field) => !field.variableName).map((field) => field.id);
  const duplicates = [];
  const seenVars = new Map();
  for (const field of dataFields) {
    if (!field.variableName) continue;
    if (seenVars.has(field.variableName)) duplicates.push({ variableName: field.variableName, ids: [seenVars.get(field.variableName), field.id] });
    else seenVars.set(field.variableName, field.id);
  }
  const childIds = new Set(fields.flatMap(getFieldChildIds));
  const duplicatedChildRoots = normalized.schema.pages.flatMap((page) => (page.fields || []).filter((id) => childIds.has(id)).map((id) => ({ pageId: page.id, fieldId: id })));
  const dataActionButtons = fields.filter((field) => field.type === "button" && (field.props?.dataActionFlowId || field.props?.dataActionId)).map((field) => ({ id: field.id, label: field.label, dataActionFlowId: field.props?.dataActionFlowId || field.props?.dataActionId, dataActionLabel: field.props?.dataActionLabel }));
  const imageScaleIssues = fields.filter((field) => field.props?.imageScale !== undefined && (Number(field.props.imageScale) < 50 || Number(field.props.imageScale) > 200)).map((field) => field.id);
  return {
    fieldCount: fields.length,
    pageCount: normalized.schema?.pages?.length || 0,
    types: Object.fromEntries([...new Set(fields.map((field) => field.type))].sort().map((type) => [type, fields.filter((field) => field.type === type).length])),
    missingVariableNames,
    duplicateVariableNames: duplicates,
    unsupportedTypes,
    duplicatedChildRoots,
    dataActionButtons,
    imageScaleIssues,
  };
}

async function callTelnyx({ endpoint, apiKey, model, promptCase, guided }) {
  const body = {
    model,
    stream: false,
    temperature: 0.1,
    max_tokens: 5000,
    messages: [
      { role: "system", content: buildFormAiSystemPrompt() },
      { role: "user", content: buildFormAiUserPayload({ prompt: promptCase.prompt, currentForm: baseForm() }) },
    ],
  };
  if (guided) {
    body.response_format = { type: "json_object" };
    body.guided_json = FORM_AI_OPERATION_SCHEMA;
  } else {
    body.response_format = { type: "json_object" };
  }
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  const elapsedMs = Date.now() - started;
  let apiJson = null;
  try { apiJson = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const detail = apiJson?.errors?.[0]?.detail || apiJson?.errors?.[0]?.title || apiJson?.error?.message || apiJson?.error || apiJson?.message || raw;
    return { ok: false, httpStatus: response.status, elapsedMs, apiError: String(detail).slice(0, 1000) };
  }
  const message = apiJson?.choices?.[0]?.message || apiJson?.data?.choices?.[0]?.message || apiJson?.message || {};
  const content = message.content || message.reasoning_content || message.reasoning || apiJson?.content || "";
  const result = { ok: true, httpStatus: response.status, elapsedMs, finishReason: apiJson?.choices?.[0]?.finish_reason || apiJson?.data?.choices?.[0]?.finish_reason || null, contentChars: String(content).length };
  try {
    const parsed = extractJson(content);
    result.parseSuccess = true;
    result.operationCount = Array.isArray(parsed.operations) ? parsed.operations.length : 0;
    const opValidation = validateFormOperations(parsed.operations || []);
    result.operationValidation = opValidation;
    if (opValidation.ok) {
      const applied = applyFormOperations(baseForm(), parsed.operations || []);
      result.formValidation = applied.validation;
      result.audit = fieldAudit(applied.form);
      result.normalizationSuccess = applied.validation.ok;
    } else {
      result.formValidation = { ok: false, errors: [] };
      result.audit = null;
      result.normalizationSuccess = false;
    }
  } catch (error) {
    result.parseSuccess = false;
    result.parseError = error.message;
    result.normalizationSuccess = false;
  }
  return result;
}

function scoreResult(result) {
  if (!result.ok || !result.parseSuccess || !result.normalizationSuccess) return 0;
  let score = 50;
  const audit = result.audit || {};
  score += Math.min(20, (audit.fieldCount || 0));
  score += Math.min(10, (audit.pageCount || 0) * 3);
  if (!audit.missingVariableNames?.length) score += 10;
  if (!audit.duplicateVariableNames?.length) score += 5;
  if (!audit.unsupportedTypes?.length) score += 5;
  if (!audit.duplicatedChildRoots?.length) score += 5;
  if (audit.dataActionButtons?.length) score += 5;
  return score;
}

async function main() {
  loadDotEnv();
  const apiKey = process.env.TELNYX_CHAT_API_KEY || process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error("TELNYX_CHAT_API_KEY/TELNYX_API_KEY not found in environment or .env");
  const endpoint = process.env.TELNYX_CHAT_COMPLETIONS_URL || "https://api.telnyx.com/v2/ai/chat/completions";
  const models = (argValue("--models") || DEFAULT_MODELS.join(",")).split(",").map((x) => x.trim()).filter(Boolean);
  const outputPath = path.resolve(repoRoot, argValue("--out") || "tmp/form-builder-ai-model-eval-results.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const results = [];
  for (const model of models) {
    for (const promptCase of PROMPTS) {
      for (const guided of [false, true]) {
        process.stdout.write(`Testing ${model} / ${promptCase.id} / ${guided ? "guided_json" : "json_object"}... `);
        try {
          const result = await callTelnyx({ endpoint, apiKey, model, promptCase, guided });
          const score = scoreResult(result);
          results.push({ model, promptId: promptCase.id, level: promptCase.level, guided, score, ...result });
          process.stdout.write(`${result.ok ? "ok" : "error"} score=${score}\n`);
        } catch (error) {
          results.push({ model, promptId: promptCase.id, level: promptCase.level, guided, score: 0, ok: false, apiError: error.message });
          process.stdout.write(`exception ${error.message}\n`);
        }
      }
    }
  }
  const summary = models.map((model) => {
    const rows = results.filter((item) => item.model === model);
    const successes = rows.filter((item) => item.ok && item.parseSuccess && item.normalizationSuccess);
    const guidedRows = rows.filter((item) => item.guided);
    const unguidedRows = rows.filter((item) => !item.guided);
    return {
      model,
      total: rows.length,
      valid: successes.length,
      guidedValid: guidedRows.filter((item) => item.ok && item.parseSuccess && item.normalizationSuccess).length,
      unguidedValid: unguidedRows.filter((item) => item.ok && item.parseSuccess && item.normalizationSuccess).length,
      averageScore: Math.round(rows.reduce((sum, item) => sum + (item.score || 0), 0) / Math.max(rows.length, 1)),
      blockers: rows.filter((item) => !item.ok).map((item) => ({ promptId: item.promptId, guided: item.guided, error: item.apiError })).slice(0, 4),
    };
  });
  const payload = { generatedAt: new Date().toISOString(), endpoint: endpoint.replace(/\?.*$/, ""), prompts: PROMPTS.map(({ id, level }) => ({ id, level })), summary, results };
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${outputPath}`);
  console.table(summary.map(({ model, valid, guidedValid, unguidedValid, averageScore }) => ({ model, valid, guidedValid, unguidedValid, averageScore })));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

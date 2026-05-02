import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { applyFormOperations, validateFormOperations } from "@/lib/forms/form-operations";

const OPERATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string" },
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          type: { type: "string", enum: ["addField", "updateField", "removeField", "moveField", "addToLayout", "setBinding", "setQueueAssignment", "setDataTargetProposal"] },
          op: { type: "string" },
          id: { type: "string" },
          fieldId: { type: "string" },
          index: { type: "number" },
          field: { type: "object", additionalProperties: true },
          patch: { type: "object", additionalProperties: true },
          binding: {},
          value: {},
          queue_ids: { type: "array", items: { type: "string" } },
          queue_names: { type: "array", items: { type: "string" } },
          auto_open: { type: "boolean" },
          proposal: { type: "object", additionalProperties: true },
        },
      },
    },
  },
  required: ["operations"],
};

function deterministicOperations(prompt = "") {
  const text = prompt.toLowerCase();
  if (text.includes("email")) return [{ type: "addField", field: { id: "email", type: "text", label: "Email", required: text.includes("required") } }];
  if (text.includes("section")) return [{ type: "addField", field: { id: `section_${Date.now()}`, type: "section", label: "New section", helpText: prompt } }];
  if (text.includes("queue")) return [{ type: "setQueueAssignment", queue_names: [prompt.match(/queue\s+([A-Za-z0-9 _-]+)/i)?.[1]?.trim() || "Sales"], auto_open: text.includes("auto") }];
  return [{ type: "addField", field: { id: `field_${Date.now()}`, type: "text", label: "New field", required: false } }];
}

function extractJson(content = "") {
  if (typeof content !== "string") return content;
  const trimmed = content.trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try { return JSON.parse(trimmed); } catch (firstError) {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const candidate = trimmed.slice(first, last + 1);
      try { return JSON.parse(candidate); } catch (secondError) {
        throw new Error(`AI returned invalid JSON: ${secondError.message}`);
      }
    }
    throw new Error(`AI returned non-JSON content: ${firstError.message}`);
  }
}

const FORM_RELATED_PATTERNS = [
  /form/i, /formular/i, /field/i, /pole/i, /input/i, /textarea/i, /select/i, /dropdown/i, /radio/i, /checkbox/i,
  /button/i, /label/i, /section/i, /row/i, /column/i, /grid/i, /layout/i, /schema/i, /jsonb/i, /queue/i,
  /client_state/i, /header/i, /binding/i, /template/i, /validation/i, /required/i, /placeholder/i, /zgod/i,
  /weryfik/i, /lead/i, /support/i, /ticket/i, /appointment/i, /marketing/i, /complaint/i, /customer/i,
];

function isFormBuilderPrompt(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return FORM_RELATED_PATTERNS.some((pattern) => pattern.test(text));
}

function outOfScopeResponse() {
  return {
    ok: true,
    operations: [],
    form: null,
    validation: { ok: true, errors: [] },
    ai: {
      used: false,
      outOfScope: true,
      reason: "I only help build and modify contact-center forms. Try asking: ‘Create a customer verification form with name, phone, account ID, consent checkbox, and AI handoff summary from client_state.’",
    },
  };
}

async function getTelnyxOperations({ prompt, currentForm, apiKey }) {
  const endpoint = process.env.TELNYX_CHAT_COMPLETIONS_URL || "https://api.telnyx.com/v2/ai/chat/completions";
  const model = process.env.FORM_BUILDER_AI_MODEL || process.env.TELNYX_CHAT_MODEL || "moonshotai/Kimi-K2.5";
  const system = `You are the AI form-builder agent inside a Telnyx contact-center admin UI.
Scope: ONLY help create or modify contact-center web forms, their fields, layout blocks, queue assignment, context bindings, validation hints, and data-target proposals.
If the user asks for anything unrelated to building/modifying forms, return exactly: {"reason":"I only help build and modify contact-center forms. Try asking: ‘Create a customer verification form with name, phone, account ID, consent checkbox, and AI handoff summary from client_state.’","operations":[]}.
Return only valid JSON matching {"reason":"short summary","operations":[...]}. Never return markdown, HTML, React, SQL, shell commands, migrations, or prose outside JSON.
Allowed operations: addField, updateField, removeField, moveField, addToLayout, setBinding, setQueueAssignment, setDataTargetProposal.
Supported field types: section, row, columns, grid, label, text, textarea, select, radio, checkbox, button, image, context_value, hidden.
For layout blocks, create fields with type section/row/columns/grid and visual props only; keep layout.order compatible with existing flat arrays.
Use stable snake_case field ids.`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0.1,
      max_tokens: 2400,
      // Telnyx Chat Completions follows the OpenAI-compatible chat shape used elsewhere in this project.
      // Keep JSON enforcement in prompt + server-side validation because not all Telnyx-hosted models support guided_json/response_format.
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify({ prompt, currentForm }) },
      ],
    }),
  });
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!res.ok) {
    const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || data?.error?.message || data?.error || data?.message || raw;
    throw new Error(`Telnyx Chat Completion failed (${res.status}): ${detail}`);
  }
  const content = data?.choices?.[0]?.message?.content || data?.data?.choices?.[0]?.message?.content || data?.message?.content || data?.content;
  const parsed = extractJson(content);
  return { operations: Array.isArray(parsed.operations) ? parsed.operations : [], reason: parsed.reason || "Applied AI form edits.", model };
}

export async function POST(request) {
  const session = await getServerSession(authOptions); if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json(); const prompt = body.prompt || ""; const currentForm = body.currentForm || body.form || {};
  if (!isFormBuilderPrompt(prompt)) {
    const scoped = outOfScopeResponse();
    return NextResponse.json({ ...scoped, form: currentForm });
  }
  const apiKey = process.env.TELNYX_CHAT_API_KEY || process.env.TELNYX_API_KEY;
  let operations = [];
  let ai = { used: false, reason: "TELNYX_CHAT_API_KEY/TELNYX_API_KEY not configured; returned deterministic fallback operation." };
  if (apiKey) {
    try {
      const result = await getTelnyxOperations({ prompt, currentForm, apiKey });
      operations = result.operations;
      ai = { used: true, reason: result.reason, model: result.model, endpoint: process.env.TELNYX_CHAT_COMPLETIONS_URL || "/v2/ai/chat/completions" };
    } catch (err) {
      return NextResponse.json({
        ok: false,
        operations: [],
        form: currentForm,
        validation: { ok: false, errors: [err.message] },
        ai: {
          used: false,
          error: err.message,
          reason: `I could not safely apply the AI response because Telnyx returned an invalid or unusable form-operation JSON. Please try again with a more specific form-building request, e.g. “Add a required email field and a two-column consent section.” Details: ${err.message}`,
        },
      }, { status: 200 });
    }
  } else {
    return NextResponse.json({
      ok: false,
      operations: [],
      form: currentForm,
      validation: { ok: false, errors: ["TELNYX_CHAT_API_KEY/TELNYX_API_KEY not configured"] },
      ai: {
        used: false,
        error: "TELNYX_CHAT_API_KEY/TELNYX_API_KEY not configured",
        reason: "Telnyx Chat Completion is not configured on the server, so I cannot safely modify the form with AI. Configure TELNYX_API_KEY or TELNYX_CHAT_API_KEY and try a form-building prompt like: ‘Create a sales lead form with contact info, budget, timeline, and notes.’",
      },
    }, { status: 200 });
  }
  const opValidation = validateFormOperations(operations); const result = opValidation.ok ? applyFormOperations(currentForm, operations) : { form: currentForm, validation: opValidation };
  return NextResponse.json({ ok: opValidation.ok && result.validation.ok, operations, form: result.form, validation: result.validation, ai });
}

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
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(trimmed); } catch {}
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error("AI returned non-JSON content");
}

async function getTelnyxOperations({ prompt, currentForm, apiKey }) {
  const endpoint = process.env.TELNYX_CHAT_COMPLETIONS_URL || "https://api.telnyx.com/v2/ai/chat/completions";
  const model = process.env.FORM_BUILDER_AI_MODEL || process.env.TELNYX_CHAT_MODEL || "meta-llama/Meta-Llama-3.1-8B-Instruct";
  const system = `You edit a canonical contact-center form JSON model. Return only JSON matching {"reason":"short summary","operations":[...]}. Never return HTML, React, SQL, shell commands, migrations, or prose outside JSON. Use only these operations: addField, updateField, removeField, moveField, addToLayout, setBinding, setQueueAssignment, setDataTargetProposal. Supported field types: section, row, columns, grid, label, text, textarea, select, radio, checkbox, button, image, context_value, hidden. For layout blocks, create fields with type section/row/columns/grid and visual props only; keep layout.order compatible with existing flat arrays.`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0.1,
      max_tokens: 1200,
      guided_json: OPERATION_SCHEMA,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify({ prompt, currentForm }) },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.errors?.[0]?.detail || data?.error || `Telnyx Chat Completion failed (${res.status})`);
  const content = data?.choices?.[0]?.message?.content || data?.data?.choices?.[0]?.message?.content || data?.message?.content || data?.content;
  const parsed = extractJson(content);
  return { operations: Array.isArray(parsed.operations) ? parsed.operations : [], reason: parsed.reason || "Applied AI form edits.", model };
}

export async function POST(request) {
  const session = await getServerSession(authOptions); if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json(); const prompt = body.prompt || ""; const currentForm = body.currentForm || body.form || {};
  const apiKey = process.env.TELNYX_CHAT_API_KEY || process.env.TELNYX_API_KEY;
  let operations = [];
  let ai = { used: false, reason: "TELNYX_CHAT_API_KEY/TELNYX_API_KEY not configured; returned deterministic fallback operation." };
  if (apiKey) {
    try {
      const result = await getTelnyxOperations({ prompt, currentForm, apiKey });
      operations = result.operations;
      ai = { used: true, reason: result.reason, model: result.model, endpoint: process.env.TELNYX_CHAT_COMPLETIONS_URL || "/v2/ai/chat/completions" };
    } catch (err) {
      operations = deterministicOperations(prompt);
      ai = { used: false, reason: `${err.message}; returned deterministic fallback operation.` };
    }
  } else {
    operations = deterministicOperations(prompt);
  }
  const opValidation = validateFormOperations(operations); const result = opValidation.ok ? applyFormOperations(currentForm, operations) : { form: currentForm, validation: opValidation };
  return NextResponse.json({ ok: opValidation.ok && result.validation.ok, operations, form: result.form, validation: result.validation, ai });
}

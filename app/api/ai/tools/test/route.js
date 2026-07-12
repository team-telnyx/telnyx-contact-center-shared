/**
 * Test a Tools Library webhook tool through Telnyx assistant tool test runtime.
 * POST /api/ai/tools/test
 *
 * Webhook tools must be tested by Telnyx via
 * /ai/assistants/{assistant_id}/tools/{tool_id}/test so secret/template
 * resolution and runtime semantics match assistant testing.
 */

import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

async function telnyxJson(path, { apiKey, method = "GET", body } = {}) {
  const res = await fetch(buildTelnyxV2Url(path), {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const error = new Error(data?.detail || data?.message || text || "Telnyx API error");
    error.status = res.status;
    error.response = data;
    throw error;
  }

  return data?.data || data;
}

function getWebhookDefinition(tool) {
  return tool?.webhook || tool?.tool_definition || {};
}

function normalizedWebhookFingerprint(tool) {
  const wh = getWebhookDefinition(tool);
  const bodyParameters = wh?.body_parameters || {};
  return JSON.stringify({
    type: tool?.type || "webhook",
    url: String(wh?.url || "").trim(),
    method: String(wh?.method || "POST").trim().toUpperCase(),
    required: Array.isArray(bodyParameters.required)
      ? [...bodyParameters.required].map(String).sort()
      : [],
    properties: bodyParameters.properties
      ? Object.keys(bodyParameters.properties).map(String).sort()
      : [],
  });
}

function coerceWebhookTestArguments(testArguments = {}) {
  const typedArguments = {};
  const stringFields = new Set([
    "to",
    "from",
    "messaging_profile_id",
    "phone_number",
    "number",
    "id",
    "uuid",
  ]);

  for (const [key, value] of Object.entries(testArguments || {})) {
    if (value === "" || value === null || value === undefined) continue;

    if (typeof value === "boolean" || typeof value === "number") {
      typedArguments[key] = value;
    } else if (typeof value === "string") {
      if (value.trim().startsWith("+") || stringFields.has(key.toLowerCase())) {
        typedArguments[key] = value;
      } else {
        const lowerValue = value.toLowerCase().trim();
        if (lowerValue === "true") typedArguments[key] = true;
        else if (lowerValue === "false") typedArguments[key] = false;
        else if (!isNaN(Number(value)) && value.trim() !== "") {
          typedArguments[key] = Number(value);
        } else {
          typedArguments[key] = value;
        }
      }
    } else {
      typedArguments[key] = value;
    }
  }

  return typedArguments;
}

function findMatchingAssistantTool(assistant, libraryTool) {
  const assistantTools = Array.isArray(assistant?.tools) ? assistant.tools : [];
  const exact = assistantTools.find(
    (tool) => String(tool?.tool_id || "") === String(libraryTool?.id || "")
  );
  if (exact?.tool_id) return exact;

  const libraryFingerprint = normalizedWebhookFingerprint(libraryTool);
  return assistantTools.find(
    (tool) =>
      tool?.type === libraryTool?.type &&
      tool?.tool_id &&
      normalizedWebhookFingerprint(tool) === libraryFingerprint
  );
}

async function findAssistantToolContext({ apiKey, tool, requestedAssistantId }) {
  if (requestedAssistantId) {
    const assistant = await telnyxJson(
      `/ai/assistants/${encodeURIComponent(requestedAssistantId)}`,
      { apiKey }
    );
    const assistantTool = findMatchingAssistantTool(assistant, tool);
    if (assistantTool?.tool_id) {
      return { assistantId: assistant.id, assistantToolId: assistantTool.tool_id };
    }
    return null;
  }

  const assistantsResponse = await telnyxJson("/ai/assistants", { apiKey });
  const assistants = Array.isArray(assistantsResponse) ? assistantsResponse : [];

  for (const assistant of assistants) {
    const assistantTool = findMatchingAssistantTool(assistant, tool);
    if (assistantTool?.tool_id) {
      return { assistantId: assistant.id, assistantToolId: assistantTool.tool_id };
    }
  }

  return null;
}

export async function POST(request) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing TELNYX_API_KEY" },
        { status: 500 }
      );
    }

    const {
      toolId,
      assistantId: requestedAssistantId,
      arguments: testArguments = {},
      dynamicVariables = {},
    } = await request.json();

    if (!toolId) {
      return NextResponse.json(
        { error: "toolId is required" },
        { status: 400 }
      );
    }

    const tool = await telnyxJson(`/ai/tools/${encodeURIComponent(toolId)}`, {
      apiKey,
    });

    if (tool.type !== "webhook") {
      return NextResponse.json(
        { error: "Only webhook tools can be tested" },
        { status: 400 }
      );
    }

    const context = await findAssistantToolContext({
      apiKey,
      tool,
      requestedAssistantId,
    });

    if (!context) {
      return NextResponse.json(
        {
          error:
            "This Tools Library webhook is not attached to an assistant and no matching assistant tool was found. Assign it to an assistant before testing.",
        },
        { status: 400 }
      );
    }

    const { assistantId, assistantToolId } = context;
    const response = await telnyxJson(
      `/ai/assistants/${encodeURIComponent(assistantId)}/tools/${encodeURIComponent(assistantToolId)}/test`,
      {
        apiKey,
        method: "POST",
        body: {
          arguments: coerceWebhookTestArguments(testArguments),
          dynamic_variables: dynamicVariables,
        },
      }
    );

    return NextResponse.json({
      success: true,
      response,
      assistantId,
      assistantToolId,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err?.message || String(err), status: err?.status },
      { status: err?.status || 500 }
    );
  }
}

import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

function compact(value, fallback = "Not configured") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function truncate(value, max = 2400) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function extractSummary(payload) {
  const choice = payload?.choices?.[0];
  return (
    choice?.message?.content ||
    choice?.delta?.content ||
    payload?.content ||
    payload?.data?.content ||
    ""
  ).trim();
}

export async function POST(request, context) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { params } = await context;
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const assistant = body?.assistant || {};

    const toolCount = Array.isArray(assistant.tools) ? assistant.tools.length : 0;
    const integrationCount = Array.isArray(assistant.integrations)
      ? assistant.integrations.length
      : 0;
    const mcpServerCount = Array.isArray(assistant.mcp_servers)
      ? assistant.mcp_servers.length
      : 0;
    const dynamicVariableCount = Object.keys(assistant.dynamic_variables || {}).length;

    const systemPrompt = `You are a Telnyx AI assistant solution architect. Generate a polished executive dashboard use-case summary for an AI assistant review screen.

Rules:
- Return one concise paragraph, 55-90 words.
- Mention what the assistant is for, what channels/capabilities it appears configured for, and why the setup is valuable.
- Use confident product language, but do not invent numbers or claims not present in the configuration.
- Do not use markdown headings. Avoid bullet points.`;

    const userPrompt = `Assistant ID: ${compact(id, "draft")}
Name: ${compact(assistant.name, "Unnamed assistant")}
Description: ${compact(assistant.description, "")}
Model: ${compact(assistant.model)}
Fallback model: ${assistant.fallback_enabled ? compact(assistant.fallback_model) : "Disabled"}
STT model/provider: ${compact(assistant.transcription?.model)}
TTS voice: ${compact(assistant.voice)}
Tools: ${toolCount}
Integrations: ${integrationCount}
MCP servers: ${mcpServerCount}
Dynamic variables: ${dynamicVariableCount}
Enabled features: ${Array.isArray(assistant.enabled_features) ? assistant.enabled_features.join(", ") : "None"}
Instructions: ${truncate(assistant.instructions)}`;

    const chatPayload = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      model:
        process.env.TELNYX_AI_DASHBOARD_SUMMARY_MODEL ||
        "meta-llama/Llama-3.3-70B-Instruct",
      max_tokens: 180,
      temperature: 0.35,
      stream: false,
    };

    const apiKeyRef =
      process.env.TELNYX_OPENAI_API_REF || assistant.llm_api_key_ref || "";
    if (apiKeyRef) {
      chatPayload.api_key_ref = apiKeyRef;
    }

    const res = await fetch(buildTelnyxV2Url("/ai/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(chatPayload),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await res.json();
    const summary = extractSummary(data);
    return NextResponse.json(
      { ok: true, summary, raw: process.env.NODE_ENV === "development" ? data : undefined },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

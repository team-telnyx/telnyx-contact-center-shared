import { previewTranslationSystem } from '../../../lib/ai-operations/prompts/core.mjs';
import { prepareAiOperation } from '@/lib/ai-operations/runtime.mjs';
import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

import { withPermission } from "@/lib/authz/guard";
async function POST_handler(request) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "Missing TELNYX_API_KEY" }, { status: 500 });
    const { text, targetLanguage, sourceLanguage = "auto" } = await request.json();
    if (!String(text || "").trim() || !targetLanguage) return NextResponse.json({ error: "Text and targetLanguage are required" }, { status: 400 });
    const response = await fetch(buildTelnyxV2Url("/ai/chat/completions"), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(await prepareAiOperation('preview-translation', {
        temperature: 0,
        max_tokens: 500,
        messages: [
          { role: "system", content: previewTranslationSystem() },
          { role: "user", content: `Source language: ${sourceLanguage}\nTarget language: ${targetLanguage}\nText:\n${text}` },
        ],
      })),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return NextResponse.json({ error: data?.errors?.[0]?.detail || "Translation failed" }, { status: response.status });
    const translatedText = data?.choices?.[0]?.message?.content || data?.data?.choices?.[0]?.message?.content || "";
    return NextResponse.json({ translatedText: String(translatedText).trim() });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Translation failed" }, { status: 500 });
  }
}

// Phase 0 hardening: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("telephony_tools:use", POST_handler, { route: "/api/translate" });

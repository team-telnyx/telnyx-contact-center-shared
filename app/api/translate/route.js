import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export async function POST(request) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "Missing TELNYX_API_KEY" }, { status: 500 });
    const { text, targetLanguage, sourceLanguage = "auto" } = await request.json();
    if (!String(text || "").trim() || !targetLanguage) return NextResponse.json({ error: "Text and targetLanguage are required" }, { status: 400 });
    const response = await fetch(buildTelnyxV2Url("/ai/chat/completions"), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.TELNYX_TRANSLATION_MODEL || "meta-llama/Llama-3.3-70B-Instruct",
        temperature: 0,
        max_tokens: 500,
        messages: [
          { role: "system", content: "Translate the supplied text faithfully. Return only the translated text with no explanation or quotation marks." },
          { role: "user", content: `Source language: ${sourceLanguage}\nTarget language: ${targetLanguage}\nText:\n${text}` },
        ],
      }),
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
